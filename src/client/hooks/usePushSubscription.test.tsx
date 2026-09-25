import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { render } from 'preact'
import { createSession, getDb, initDb, markPushSubscriptionDead, registerPubkey } from '../../server/db'
import { SettingsModal } from '../components/SettingsModal'
import { ToastProvider } from '../components/Toast'
import { createFetch } from '../../server/router'
import * as limiters from '../../server/rate-limiters'
import type { PushCoordinator, PushCoordinatorEnv, PushLockManager } from '../lib/push-coordinator'
import { createClock, createLockManager, deferred, isSettled, loadPushWorker } from '../lib/push-coordination.test-utils'
import type { PushSlotSummary } from '../../shared/push-slot'

const originalFetch = globalThis.fetch
const globals = new Map(['fetch', 'Request', 'Response', 'Headers', 'URL', 'URLSearchParams', 'ReadableStream',
  'WritableStream', 'TransformStream', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'structuredClone']
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let usePushSubscription: typeof import('./usePushSubscription').usePushSubscription
let coordinator: typeof import('../lib/push-coordinator')
let server: ReturnType<typeof Bun.serve>
const alice = `0x${'a'.repeat(40)}`
const bob = `0x${'b'.repeat(40)}`
let browserSub: PushSubscription | null
let failRemoval = false
const listBarriers = new Map<string, Promise<void>>()
let subscribeBarrier: Promise<void> | undefined
let vapidBarrier: Promise<void> | undefined
let nativeBarrier: Promise<void> | undefined
let lookupBarrier: Promise<void> | undefined
let unsubscribeBarrier: Promise<void> | undefined
let nativeSubscribes = 0
// The service worker's clock; tests with a controlled clock point it there.
let workerNow: () => number
const keys = { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') }

// One browser, several tabs: they share this origin's lock manager, storage and
// broadcast channel, and each holds its own hook instance and coordinator.
interface Tab {
  container: HTMLElement
  coordinator: PushCoordinator
  push: ReturnType<typeof usePushSubscription>
  pending?: Promise<unknown>
}
let openTabs: Tab[] = []
let channelName: string
let locks: PushLockManager
let tab: Tab

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost' })
  for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor)
  usePushSubscription = (await import('./usePushSubscription')).usePushSubscription
  coordinator = await import('../lib/push-coordinator')
})
afterAll(() => GlobalRegistrator.unregister())
beforeEach(async () => {
  initDb(':memory:')
  for (const address of [alice, bob]) {
    registerPubkey(address, 'test-key')
    createSession(address, address, Date.now() + 60_000)
  }
  for (const limiter of Object.values(limiters)) limiter.reset()
  server = Bun.serve({ port: 0, fetch: createFetch() })
  localStorage.clear()
  browserSub = null
  failRemoval = false
  listBarriers.clear()
  subscribeBarrier = undefined
  vapidBarrier = undefined
  nativeBarrier = undefined
  lookupBarrier = undefined
  unsubscribeBarrier = undefined
  nativeSubscribes = 0
  workerNow = () => Date.now()
  channelName = `push-tabs-${crypto.randomUUID()}`
  locks = createLockManager()
  openTabs = []
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { permission: 'granted', requestPermission: async () => 'granted' } })
  Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} })
  const pushManager = {
    getSubscription: async () => browserSub,
    subscribe: async () => {
      nativeSubscribes++
      await nativeBarrier
      if (!browserSub) {
        const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`
        browserSub = { endpoint, expirationTime: null, options: { applicationServerKey: null, userVisibleOnly: true },
          getKey: () => null, toJSON: () => ({ endpoint, keys }),
          unsubscribe: async () => {
            await unsubscribeBarrier
            if (browserSub?.endpoint === endpoint) browserSub = null
            return true
          } }
      }
      return browserSub
    },
  } as unknown as PushManager
  // The real worker script makes the native calls; its lock survives a page
  // reload, so it never shares the pages' lock manager.
  // A lookup stall applies to the worker's lookup, not the page's state read.
  const workerPush = { subscribe: pushManager.subscribe, getSubscription: async () => {
    await lookupBarrier
    return browserSub
  } } as unknown as PushManager
  const { active } = await loadPushWorker({ pushManager: workerPush, locks: createLockManager(), channelName,
    now: () => workerNow() })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    ready: Promise.resolve({ pushManager, active }),
  } })
  globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
    const path = String(input)
    if (path.endsWith('/vapid-public-key')) await vapidBarrier
    if (path.endsWith('/vapid-public-key')) return Response.json({ publicKey: 'A'.repeat(44) })
    if (failRemoval && path.endsWith('/unsubscribe')) throw new Error('offline')
    if (path.endsWith('/push/subscribe')) await subscribeBarrier
    if (path.endsWith('/subscriptions')) {
      const token = new Headers(options?.headers).get('Authorization')?.replace('Bearer ', '')
      if (token) await listBarriers.get(token)
    }
    return originalFetch(new URL(path, server.url), options)
  }, { preconnect: originalFetch.preconnect })
  tab = openTab()
})
afterEach(() => {
  for (const open of openTabs) {
    render(null, open.container)
    open.container.remove()
    open.coordinator.close()
  }
  globalThis.fetch = originalFetch
  server.stop(true)
  getDb().close()
  for (const limiter of Object.values(limiters)) limiter.reset()
})

function openTab(env: PushCoordinatorEnv = {}): Tab {
  const container = document.createElement('div')
  document.body.append(container)
  const open = {
    container,
    coordinator: coordinator.createPushCoordinator({
      locks, broadcast: () => new BroadcastChannel(channelName), ...env,
    }),
  // `push` is filled in by the first render of this tab's harness.
  } as unknown as Tab
  openTabs.push(open)
  return open
}

function SettingsHarness({ open, address, showModal }: { open: Tab; address: string; showModal: boolean }) {
  open.push = usePushSubscription(address.toLowerCase(), address, open.coordinator)
  if (showModal) return <ToastProvider><SettingsModal
    identity={{ address, publicKey: 'test-key', privateKey: '1'.repeat(64) }}
    onClose={() => {}} onImport={async () => {}}
    push={{ ...open.push,
      subscribe: () => { open.pending = open.push.subscribe() },
      unsubscribe: () => { open.pending = open.push.unsubscribe() },
      removeSlot: (slot) => { open.pending = open.push.removeSlot(slot) },
    }}
  /></ToastProvider>
  return <span>{open.push.subscribed ? 'on' : 'off'} {open.push.error}</span>
}
function mountTab(open: Tab, address = alice, showModal = false) {
  render(<SettingsHarness open={open} address={address} showModal={showModal} />, open.container)
}
function mount(address = alice, showModal = false) {
  mountTab(tab, address, showModal)
}
async function settle() { await Bun.sleep(60) }
async function list(address = alice) {
  return (await originalFetch(new URL('/api/push/subscriptions', server.url), {
    headers: { Authorization: `Bearer ${address}` },
  })).json()
}
function toggleState(open: Tab, label: string) {
  return open.container.querySelector(`[aria-label="${label}"]`)?.getAttribute('aria-pressed')
}

async function clickNotification(open: Tab, label: string) {
  const button = open.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(button).not.toBeNull()
  open.pending = undefined
  button!.click()
  expect(open.pending).toBeDefined()
  await open.pending
  await settle()
}

test('settings show actionable cap rejection without eviction and allow enabling once a slot is freed', async () => {
  for (let i = 0; i < 5; i++) {
    const response = await originalFetch(new URL('/api/push/subscribe', server.url), { method: 'POST',
      headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ installation_id: crypto.randomUUID(), expected_revision: 0,
        subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/other-${i}`, keys } }),
    })
    expect(response.status).toBe(201)
  }
  const before = await list()
  mount(alice, true)
  await settle()
  await clickNotification(tab, 'Enable notifications')
  expect(tab.container.textContent).toContain('Five notification slots are in use. Remove an old subscription')
  expect(tab.container.querySelector('[aria-label="Enable notifications"]')?.getAttribute('aria-pressed')).toBe('false')
  expect(await list()).toEqual(before)
  const slot = before.slots[0]
  expect((await originalFetch(new URL('/api/push/unsubscribe', server.url), { method: 'POST',
    headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot_id: slot.slot_id, installation_id: slot.installation_id, expected_revision: slot.revision }),
  })).status).toBe(200)
  await clickNotification(tab, 'Enable notifications')
  expect(tab.container.textContent).not.toContain('Five notification slots')
  expect(tab.container.querySelector('[aria-label="Disable notifications"]')?.getAttribute('aria-pressed')).toBe('true')
  expect((await list()).slots).toHaveLength(5)
})

test('settings list safe remote notification slots and remove an old browser', async () => {
  const oldSlots = []
  for (let i = 0; i < 2; i++) {
    oldSlots.push(await (await originalFetch(new URL('/api/push/subscribe', server.url), { method: 'POST',
      headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ installation_id: crypto.randomUUID(), expected_revision: 0,
        subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/old-${i}`, keys } }),
    })).json())
  }

  mount(alice, true)
  await settle()
  expect(tab.container.textContent).toContain(oldSlots[0].slot_id)
  expect(tab.container.textContent).toContain('Active')
  expect(tab.container.textContent).not.toContain('https://')
  await clickNotification(tab, `Remove notification slot ${oldSlots[0].slot_id}`)
  expect((await list()).slots).toEqual([expect.objectContaining({ slot_id: oldSlots[1].slot_id })])
})

test('settings manage remote slots when local push APIs are unavailable', async () => {
  const slot = await (await originalFetch(new URL('/api/push/subscribe', server.url), { method: 'POST',
    headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ installation_id: crypto.randomUUID(), expected_revision: 0,
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/unsupported-browser', keys } }),
  })).json()
  Object.defineProperty(window, 'PushManager', { configurable: true, value: undefined })

  mount(alice, true)
  await settle()
  expect(tab.container.textContent).toContain('Unavailable here')
  expect(tab.container.textContent).toContain(slot.slot_id)
  await clickNotification(tab, `Remove notification slot ${slot.slot_id}`)
  expect((await list()).slots).toEqual([])
})

test('identity changes reject stale slot refreshes and queued removals', async () => {
  const slot = await (await originalFetch(new URL('/api/push/subscribe', server.url), { method: 'POST',
    headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ installation_id: crypto.randomUUID(), expected_revision: 0,
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/stale-operation', keys } }),
  })).json()
  const aliceList = deferred<void>()
  const bobList = deferred<void>()
  listBarriers.set(alice, aliceList.promise)
  listBarriers.set(bob, bobList.promise)

  mount(alice, true)
  await Bun.sleep(10)
  mount(bob, true)
  aliceList.resolve()
  await Bun.sleep(10)
  expect(tab.container.textContent).not.toContain(slot.slot_id)
  bobList.resolve()
  await settle()

  listBarriers.clear()
  mount(alice, true)
  await settle()
  const registration = await navigator.serviceWorker.ready
  const ready = deferred<ServiceWorkerRegistration>()
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: ready.promise } })
  const blockingOperation = tab.push.unsubscribe()
  const staleRemoval = tab.push.removeSlot(slot)
  Object.defineProperty(globalThis, 'Notification', { configurable: true,
    value: { permission: 'denied', requestPermission: async () => 'denied' } })
  const supersedingOperation = tab.push.subscribe()
  ready.resolve(registration)
  await Promise.all([blockingOperation, staleRemoval, supersedingOperation])
  expect((await list()).slots).toEqual([expect.objectContaining({ slot_id: slot.slot_id })])
})

test('settings explicitly repair a dead slot without consuming another slot', async () => {
  mount(alice, true)
  await settle()
  await clickNotification(tab, 'Enable notifications')
  const slot = (await list()).slots[0]
  // The production transition used for provider 404/410, not a fabricated browser response.
  markPushSubscriptionDead(slot.slot_id, slot.revision)
  const dead = await list()
  expect(dead.slots[0].state).toBe('repair_needed')
  render(null, tab.container)
  mount(alice, true)
  await settle()
  expect(await list()).toEqual(dead)
  expect(tab.container.querySelector('[aria-label="Enable notifications"]')?.getAttribute('aria-pressed')).toBe('false')
  await clickNotification(tab, 'Enable notifications')
  expect(tab.container.querySelector('[aria-label="Disable notifications"]')?.getAttribute('aria-pressed')).toBe('true')
  expect((await list()).slots).toEqual([expect.objectContaining({
    slot_id: slot.slot_id, state: 'active', revision: dead.slots[0].revision + 1,
  })])
})

test('new identity never auto-uploads a surviving subscription and ownership conflict gives an action', async () => {
  mount()
  await settle()
  expect(await tab.push.subscribe()).toBe(true)
  const before = await list()
  render(null, tab.container)
  mount(bob)
  await settle()
  expect((await list(bob)).slots).toEqual([])
  expect(tab.container.textContent).toContain('off')
  expect(await tab.push.subscribe()).toBe(false)
  await settle()
  expect(tab.container.textContent).toContain('previous identity')
  expect(await list()).toEqual(before)
})

test('remote revocation survives reload until fresh explicit enable; cleanup failures remain off and actionable', async () => {
  mount()
  await settle()
  expect(await tab.push.subscribe()).toBe(true)
  const slot = (await list()).slots[0]
  await originalFetch(new URL('/api/push/unsubscribe', server.url), { method: 'POST',
    headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot_id: slot.slot_id, installation_id: slot.installation_id, expected_revision: slot.revision }),
  })
  render(null, tab.container)
  mount()
  await settle()
  expect(tab.container.textContent).toContain('off')
  expect((await list()).slots).toEqual([])
  expect(await tab.push.subscribe()).toBe(true)
  expect((await list()).slots[0]).toMatchObject({ slot_id: slot.slot_id, revision: 3 })
  failRemoval = true
  await tab.push.unsubscribe()
  await settle()
  expect(tab.container.textContent).toContain('server cleanup failed')
  expect((await list()).slots).toHaveLength(1)
  render(null, tab.container)
  mount()
  await settle()
  expect(tab.container.textContent).toContain('off')
  expect((await list()).slots).toHaveLength(1)
  failRemoval = false
  await tab.push.unsubscribe()
  expect((await list()).slots).toEqual([])
})

test('explicit enable persists an owned slot across reload; disable revokes it even when browser state is gone', async () => {
  mount()
  await settle()
  expect(await tab.push.subscribe()).toBe(true)
  await settle()
  const first = await list()
  expect(first.slots).toHaveLength(1)
  expect(tab.container.textContent).toContain('on')
  render(null, tab.container)
  mount(alice.toUpperCase().replace('0X', '0x'))
  await settle()
  expect((await list()).slots).toEqual(first.slots)
  expect(tab.container.textContent).toContain('on')
  browserSub = null
  await tab.push.unsubscribe()
  await settle()
  expect(await list()).toEqual({ slots: [], revocations: [{ slot_id: first.slots[0].slot_id,
    installation_id: first.slots[0].installation_id, revision: 2 }] })
  expect(tab.container.textContent).toContain('off')
  render(null, tab.container)
  mount()
  await settle()
  expect((await list()).slots).toEqual([])
  expect(tab.container.textContent).toContain('off')
})

test('a second tab converges on notification state enabled and removed elsewhere', async () => {
  const other = openTab()
  mount(alice, true)
  mountTab(other, alice, true)
  await settle()

  await clickNotification(tab, 'Enable notifications')
  await settle()
  expect(toggleState(other, 'Disable notifications')).toBe('true')

  const slot = (await list()).slots[0]
  await clickNotification(other, `Remove notification slot ${slot.slot_id}`)
  await settle()
  expect((await list()).slots).toEqual([])
  expect(toggleState(tab, 'Enable notifications')).toBe('false')
})

test('two identities enabling at once leave one owner and an actionable conflict', async () => {
  const other = openTab()
  mount(alice, true)
  mountTab(other, bob, true)
  await settle()

  const [aliceEnabled, bobEnabled] = await Promise.all([tab.push.subscribe(), other.push.subscribe()])
  await settle()

  expect([aliceEnabled, bobEnabled]).toEqual([false, true])
  expect((await list(alice)).slots).toEqual([])
  expect((await list(bob)).slots).toHaveLength(1)
  expect(tab.container.textContent).toContain('Another 0xChat tab changed notifications')
  expect(toggleState(tab, 'Enable notifications')).toBe('false')
})

test('a server write finishing after supersession neither enables nor strands the newer registration', async () => {
  const other = openTab()
  mount(alice, true)
  mountTab(other, alice, true)
  await settle()
  const accepted = deferred<void>()
  subscribeBarrier = accepted.promise

  const superseded = tab.push.subscribe()
  await Bun.sleep(20) // the first tab's enable is now waiting inside its POST
  const winner = other.push.subscribe()
  accepted.resolve()
  subscribeBarrier = undefined

  const [stale, current] = await Promise.all([superseded, winner])
  await settle()
  expect([stale, current]).toEqual([false, true])
  // The late completion removed only its own slot; the newer one survives with
  // a live browser subscription behind it.
  expect((await list()).slots).toHaveLength(1)
  expect((await list()).slots[0].state).toBe('active')
  expect(browserSub).not.toBeNull()
  expect(toggleState(other, 'Disable notifications')).toBe('true')
  expect(tab.container.textContent).toContain('Another 0xChat tab changed notifications')
})

test('without a lock API, explicit enabling works and concurrent tabs still leave one owner', async () => {
  const first = openTab({ locks: null })
  const second = openTab({ locks: null })
  mountTab(first, alice, true)
  await settle()

  await clickNotification(first, 'Enable notifications')
  expect(toggleState(first, 'Disable notifications')).toBe('true')
  expect((await list()).slots).toHaveLength(1)

  // The shared generation alone has to keep two uncoordinated tabs apart.
  mountTab(second, alice, true)
  await settle()
  const [staleTab, newerTab] = await Promise.all([first.push.unsubscribe(), second.push.subscribe()])
  await settle()

  expect([staleTab, newerTab]).toEqual([undefined, true])
  expect((await list()).slots).toHaveLength(1)
  expect(browserSub).not.toBeNull()
  expect(first.container.textContent).toContain('Another 0xChat tab changed notifications')
})

test('a newer no-lock enable survives an older disable response arriving late', async () => {
  const first = openTab({ locks: null })
  const second = openTab({ locks: null })
  mountTab(first, alice, true)
  mountTab(second, alice, true)
  await settle()
  expect(await first.push.subscribe()).toBe(true)
  await settle()

  const wrote = deferred<void>()
  const release = deferred<void>()
  const normalFetch = globalThis.fetch
  let holdFirst = true
  globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
    const response = await normalFetch(input, options)
    if (holdFirst && String(input).endsWith('/push/unsubscribe')) {
      holdFirst = false
      wrote.resolve()
      await release.promise
    }
    return response
  }, { preconnect: normalFetch.preconnect })

  const older = first.push.unsubscribe()
  await wrote.promise
  expect(await second.push.subscribe()).toBe(true)
  const winner = (await list()).slots[0]
  release.resolve()
  await older
  await settle()
  expect((await list()).slots).toEqual([expect.objectContaining({ slot_id: winner.slot_id, revision: winner.revision, state: 'active' })])
  expect(browserSub).not.toBeNull()
  expect(toggleState(second, 'Disable notifications')).toBe('true')
})

test('a same-tab identity switch cleans up a late enable without Web Locks', async () => {
  const first = openTab({ locks: null })
  mountTab(first, alice)
  await settle()
  const wrote = deferred<void>()
  const release = deferred<void>()
  const normalFetch = globalThis.fetch
  let holdFirst = true
  globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
    const response = await normalFetch(input, options)
    if (holdFirst && String(input).endsWith('/push/subscribe')) {
      holdFirst = false
      wrote.resolve()
      await release.promise
    }
    return response
  }, { preconnect: normalFetch.preconnect })

  const older = first.push.subscribe()
  await wrote.promise
  render(null, first.container)
  mountTab(first, bob)
  release.resolve()
  expect(await older).toBe(false)
  await settle()
  expect((await list(alice)).slots).toEqual([])
  expect(browserSub).toBeNull()
  expect(await first.push.subscribe()).toBe(true)
  expect((await list(bob)).slots).toHaveLength(1)
})

test('a newer tab keeps its registration when an older no-lock enable finishes late', async () => {
  const first = openTab({ locks: null })
  const second = openTab({ locks: null })
  mountTab(first, alice, true)
  mountTab(second, alice, true)
  await settle()

  const wrote = deferred()
  const release = deferred()
  const normalFetch = globalThis.fetch
  let holdFirst = true
  globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
    const response = await normalFetch(input, options)
    if (holdFirst && String(input).endsWith('/push/subscribe')) {
      holdFirst = false
      wrote.resolve()
      await release.promise
    }
    return response
  }, { preconnect: normalFetch.preconnect })

  const older = first.push.subscribe()
  await wrote.promise // the first write landed, but its response is still in flight
  const newer = await second.push.subscribe() // same browser subscription and slot
  expect(newer).toBe(true)
  const winner = (await list()).slots[0]
  expect(winner).toBeDefined()

  release.resolve()
  expect(await older).toBe(false)
  await settle()
  expect((await list()).slots).toEqual([expect.objectContaining({ slot_id: winner.slot_id, revision: winner.revision, state: 'active' })])
  expect(browserSub).not.toBeNull()
  expect(toggleState(second, 'Disable notifications')).toBe('true')
})

test('a superseded enable leaves the browser subscription another tab already owns', async () => {
  const remote = await (await originalFetch(new URL('/api/push/subscribe', server.url), { method: 'POST',
    headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ installation_id: crypto.randomUUID(), expected_revision: 0,
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/another-browser', keys } }),
  })).json()
  const other = openTab()
  mount(alice, true)
  mountTab(other, alice, true)
  await settle()
  await clickNotification(other, 'Enable notifications')
  const owned = (await list()).slots.find((slot: PushSlotSummary) => slot.slot_id !== remote.slot_id)

  // The first tab's enable reaches the server before it is superseded by a
  // removal that never touches this browser's own subscription.
  const listed = deferred<void>()
  listBarriers.set(alice, listed.promise)
  const late = tab.push.subscribe()
  await Bun.sleep(20)
  const superseding = other.push.removeSlot(remote)
  listed.resolve()
  listBarriers.clear()

  expect(await late).toBe(false)
  await superseding
  await settle()
  // Late cleanup owns nothing here, so the live registration keeps working.
  expect(browserSub).not.toBeNull()
  expect((await list()).slots).toEqual([expect.objectContaining({ slot_id: owned.slot_id, state: 'active' })])
  expect(toggleState(other, 'Disable notifications')).toBe('true')
})

const TIMED_OUT = 'did not respond within 30 seconds'

// Hold the next request to `suffix` before it reaches the server until the
// test lets it through or fails it.
function holdNext(suffix: string) {
  const reached = deferred()
  const gate = deferred<boolean>()
  const normalFetch = globalThis.fetch
  let armed = true
  globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
    if (armed && String(input).endsWith(suffix)) {
      armed = false
      reached.resolve()
      if (!(await gate.promise)) throw new Error('offline')
    }
    return normalFetch(input, options)
  }, { preconnect: normalFetch.preconnect })
  return { reached: reached.promise, release: () => gate.resolve(true), fail: () => gate.resolve(false) }
}

// A reload: the old page's locks go with it, and a fresh tab mounts.
async function reload(old: Tab, clock: ReturnType<typeof createClock>): Promise<Tab> {
  render(null, old.container)
  locks = createLockManager()
  const fresh = openTab({ clock })
  mountTab(fresh, alice, true)
  await settle()
  return fresh
}

test('a stalled service worker times out enabling, and late readiness neither uploads nor enables', async () => {
  const clock = createClock()
  workerNow = clock.now
  const timed = openTab({ clock })
  mountTab(timed, alice, true)
  await settle()
  const registration = await navigator.serviceWorker.ready
  const ready = deferred<ServiceWorkerRegistration>()
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: ready.promise } })

  const enabling = timed.push.subscribe()
  await settle()
  clock.advance(30_000)
  expect(await enabling).toBe(false)
  await settle()
  expect(timed.container.textContent).toContain(TIMED_OUT)

  ready.resolve(registration)
  await settle()
  expect((await list()).slots).toEqual([])
  expect(browserSub).toBeNull()
  expect(toggleState(timed, 'Enable notifications')).toBe('false')

  // Once the browser recovers, a fresh attempt works normally.
  expect(await timed.push.subscribe()).toBe(true)
  expect((await list()).slots).toHaveLength(1)
})

test('time spent answering the permission prompt does not count toward the timeout', async () => {
  const clock = createClock()
  workerNow = clock.now
  const timed = openTab({ clock })
  mountTab(timed)
  await settle()
  const answer = deferred<NotificationPermission>()
  Object.defineProperty(globalThis, 'Notification', { configurable: true,
    value: { permission: 'default', requestPermission: () => answer.promise } })

  const enabling = timed.push.subscribe()
  await settle()
  clock.advance(5 * 60_000)
  answer.resolve('granted')
  expect(await enabling).toBe(true)
  expect((await list()).slots).toHaveLength(1)
})

test('a stalled browser subscription holds off other tabs and reloads until it settles, and expired requests never start', async () => {
  const clock = createClock()
  workerNow = clock.now
  const stalled = openTab({ clock })
  const waiting = openTab({ clock })
  mountTab(stalled, alice, true)
  mountTab(waiting, alice, true)
  await settle()
  const native = deferred()
  nativeBarrier = native.promise

  const first = stalled.push.subscribe()
  await settle()
  clock.advance(30_000)
  expect(await first).toBe(false)

  // The native call still holds the page lock, so another tab's enable waits.
  const second = waiting.push.subscribe()
  await settle()
  expect(await isSettled(second)).toBe(false)

  // A reload drops the page lock, not the worker's: the reloaded tab's native
  // call queues behind the stalled one instead of racing it.
  const reloaded = await reload(stalled, clock)
  const third = reloaded.push.subscribe()
  await settle()
  clock.advance(30_000)
  expect(await third).toBe(false)
  expect(await second).toBe(false)
  await settle()
  expect(reloaded.container.textContent).toContain(TIMED_OUT)
  expect(waiting.container.textContent).toContain(TIMED_OUT)

  nativeBarrier = undefined
  native.resolve()
  await settle()
  // Only the stalled call reached the browser; nothing it produced was uploaded.
  expect(nativeSubscribes).toBe(1)
  expect((await list()).slots).toEqual([])

  expect(await reloaded.push.subscribe()).toBe(true)
  expect((await list()).slots).toEqual([expect.objectContaining({ state: 'active' })])
  expect(browserSub).not.toBeNull()
  expect(toggleState(reloaded, 'Disable notifications')).toBe('true')
})

test.each(['succeeds', 'fails'] as const)(
  'an enable after reloading mid-disable waits for the browser removal, which %s late, and keeps its binding',
  async (outcome) => {
    const clock = createClock()
    workerNow = clock.now
    const closing = openTab({ clock })
    mountTab(closing, alice, true)
    await settle()
    expect(await closing.push.subscribe()).toBe(true)
    const doomed = browserSub!.endpoint
    const removal = deferred()
    unsubscribeBarrier = removal.promise.then(() => { if (outcome === 'fails') throw new Error('push service unavailable') })

    const disabling = closing.push.unsubscribe()
    await settle()
    clock.advance(30_000)
    expect(await disabling).toBeUndefined()
    expect((await list()).slots).toEqual([])

    // Well past any fixed grace period: only the removal settling may let the
    // next enable touch the browser subscription.
    const reloaded = await reload(closing, clock)
    clock.advance(5 * 60_000)
    const enabling = reloaded.push.subscribe()
    await settle()
    expect(await isSettled(enabling)).toBe(false)
    expect((await list()).slots).toEqual([])

    unsubscribeBarrier = undefined
    removal.resolve()
    expect(await enabling).toBe(true)
    await settle()
    expect(browserSub).not.toBeNull()
    if (outcome === 'succeeds') expect(browserSub!.endpoint).not.toBe(doomed)
    else expect(browserSub!.endpoint).toBe(doomed)
    expect((await list()).slots).toEqual([expect.objectContaining({ state: 'active' })])
    expect(toggleState(reloaded, 'Disable notifications')).toBe('true')
  })

test.each([
  ['VAPID key retrieval', 'succeeds', '/vapid-public-key'],
  ['VAPID key retrieval', 'fails', '/vapid-public-key'],
  ['the server slot lookup', 'succeeds', '/push/subscriptions'],
  ['the server slot lookup', 'fails', '/push/subscriptions'],
  ['the server write', 'succeeds', '/push/subscribe'],
  ['the server write', 'fails', '/push/subscribe'],
] as const)('an enable stalled in %s times out, and a request that %s late leaves the newer binding alone',
  async (_phase, outcome, suffix) => {
    const clock = createClock()
    workerNow = clock.now
    const timed = openTab({ clock })
    mountTab(timed, alice, true)
    await settle()
    const held = holdNext(suffix)

    const enabling = timed.push.subscribe()
    await held.reached
    clock.advance(30_000)
    expect(await enabling).toBe(false)
    await settle()
    expect(timed.container.textContent).toContain(TIMED_OUT)

    const reloaded = await reload(timed, clock)
    expect(await reloaded.push.subscribe()).toBe(true)
    const winner = (await list()).slots[0]
    const endpoint = browserSub!.endpoint

    if (outcome === 'succeeds') held.release()
    else held.fail()
    await settle()
    expect((await list()).slots).toEqual([expect.objectContaining({ slot_id: winner.slot_id, revision: winner.revision, state: 'active' })])
    expect(browserSub?.endpoint).toBe(endpoint)
    expect(toggleState(reloaded, 'Disable notifications')).toBe('true')
    expect(timed.container.textContent).not.toContain('Could not enable')
  })

async function disableStalledIn(suffix: string | undefined, outcome: 'succeeds' | 'fails') {
  const clock = createClock()
  workerNow = clock.now
  const timed = openTab({ clock })
  mountTab(timed, alice, true)
  await settle()
  expect(await timed.push.subscribe()).toBe(true)
  const lookup = deferred()
  const held = suffix ? holdNext(suffix) : undefined
  if (!suffix) lookupBarrier = lookup.promise.then(() => { if (outcome === 'fails') throw new Error('browser busy') })

  const disabling = timed.push.unsubscribe()
  if (held) await held.reached
  else await settle()
  clock.advance(30_000)
  expect(await disabling).toBeUndefined()
  await settle()
  expect(timed.container.textContent).toContain(TIMED_OUT)

  const reloaded = await reload(timed, clock)
  const enabling = reloaded.push.subscribe()
  // A browser lookup still holds the worker's queue; server calls do not.
  if (!suffix) {
    await settle()
    expect(await isSettled(enabling)).toBe(false)
    lookupBarrier = undefined
    lookup.resolve()
  }
  expect(await enabling).toBe(true)
  const winner = (await list()).slots[0]
  const endpoint = browserSub!.endpoint

  if (held) {
    if (outcome === 'succeeds') held.release()
    else held.fail()
  }
  await settle()
  expect((await list()).slots).toEqual([expect.objectContaining({ slot_id: winner.slot_id, revision: winner.revision, state: 'active' })])
  expect(browserSub?.endpoint).toBe(endpoint)
  expect(toggleState(reloaded, 'Disable notifications')).toBe('true')
  expect(timed.container.textContent).not.toContain('Could not disable')
}

test.each([
  ['the browser subscription lookup', 'succeeds', undefined],
  ['the browser subscription lookup', 'fails', undefined],
  ['the server slot lookup', 'succeeds', '/push/subscriptions'],
  ['the server slot lookup', 'fails', '/push/subscriptions'],
  ['the server removal', 'succeeds', '/push/unsubscribe'],
  ['the server removal', 'fails', '/push/unsubscribe'],
] as const)('a disable stalled in %s times out, and a request that %s late leaves the newer binding alone',
  (_phase, outcome, suffix) => disableStalledIn(suffix, outcome))

test('a disable stuck behind another tab times out so the identity can still switch', async () => {
  const clock = createClock()
  workerNow = clock.now
  const holder = openTab({ clock })
  const switching = openTab({ clock })
  mountTab(holder, alice, true)
  mountTab(switching, alice, true)
  await settle()
  const native = deferred()
  nativeBarrier = native.promise
  void holder.push.subscribe()
  await settle()

  const disabling = switching.push.unsubscribe()
  await settle()
  clock.advance(30_000)
  expect(await disabling).toBeUndefined()

  // The next identity loads its own state while the old operation is unresolved.
  const bobSlot = await (await originalFetch(new URL('/api/push/subscribe', server.url), { method: 'POST',
    headers: { Authorization: `Bearer ${bob}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ installation_id: crypto.randomUUID(), expected_revision: 0,
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/bob-elsewhere', keys } }),
  })).json()
  mountTab(switching, bob, true)
  await settle()
  expect(switching.container.textContent).toContain(bobSlot.slot_id)
  expect(switching.container.textContent).not.toContain(TIMED_OUT)
  native.resolve()
})
