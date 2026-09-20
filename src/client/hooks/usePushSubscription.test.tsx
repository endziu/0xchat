import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { render } from 'preact'
import { createSession, getDb, initDb, markPushSubscriptionDead, registerPubkey } from '../../server/db'
import { SettingsModal } from '../components/SettingsModal'
import { ToastProvider } from '../components/Toast'
import { createFetch } from '../../server/router'
import * as limiters from '../../server/rate-limiters'

const originalFetch = globalThis.fetch
const globals = new Map(['fetch', 'Request', 'Response', 'Headers', 'URL', 'URLSearchParams', 'ReadableStream',
  'WritableStream', 'TransformStream', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'structuredClone']
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let usePushSubscription: typeof import('./usePushSubscription').usePushSubscription
let server: ReturnType<typeof Bun.serve>
const alice = `0x${'a'.repeat(40)}`
const bob = `0x${'b'.repeat(40)}`
let current: ReturnType<typeof usePushSubscription>
let container: HTMLElement
let browserSub: PushSubscription | null
let failRemoval = false
let pendingAction: Promise<unknown> | undefined
const keys = { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') }

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost' })
  for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor)
  usePushSubscription = (await import('./usePushSubscription')).usePushSubscription
})
afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
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
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { permission: 'granted', requestPermission: async () => 'granted' } })
  Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    ready: Promise.resolve({ pushManager: {
      getSubscription: async () => browserSub,
      subscribe: async () => {
        if (!browserSub) {
          const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`
          browserSub = { endpoint, expirationTime: null, options: { applicationServerKey: null, userVisibleOnly: true },
            getKey: () => null, toJSON: () => ({ endpoint, keys }),
            unsubscribe: async () => { browserSub = null; return true } }
        }
        return browserSub
      },
    } }),
  } })
  globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
    const path = String(input)
    if (path.endsWith('/vapid-public-key')) return Response.json({ publicKey: 'A'.repeat(44) })
    if (failRemoval && path.endsWith('/unsubscribe')) throw new Error('offline')
    return originalFetch(new URL(path, server.url), options)
  }, { preconnect: originalFetch.preconnect })
  container = document.createElement('div')
  document.body.append(container)
})
afterEach(() => {
  render(null, container)
  container.remove()
  globalThis.fetch = originalFetch
  server.stop(true)
  getDb().close()
  for (const limiter of Object.values(limiters)) limiter.reset()
})
function mount(address = alice, showModal = false) {
  function Settings() {
    current = usePushSubscription(address.toLowerCase(), address)
    if (showModal) return <ToastProvider><SettingsModal
      identity={{ address, publicKey: 'test-key', privateKey: '1'.repeat(64) }}
      onClose={() => {}} onImport={async () => {}}
      pushSupported={current.supported} pushSubscribed={current.subscribed}
      pushRemovable={current.removable} pushPermission={current.permission} pushError={current.error}
      onPushSubscribe={() => { pendingAction = current.subscribe() }}
      onPushUnsubscribe={() => { pendingAction = current.unsubscribe() }}
    /></ToastProvider>
    return <span>{current.subscribed ? 'on' : 'off'} {current.error}</span>
  }
  render(<Settings />, container)
}
async function settle() { await Bun.sleep(60) }
async function list(address = alice) {
  return (await originalFetch(new URL('/api/push/subscriptions', server.url), {
    headers: { Authorization: `Bearer ${address}` },
  })).json()
}

async function clickNotification(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(button).not.toBeNull()
  pendingAction = undefined
  button!.click()
  expect(pendingAction).toBeDefined()
  await pendingAction
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
  await clickNotification('Enable notifications')
  expect(container.textContent).toContain('Five notification slots are in use. Remove an old subscription')
  expect(container.querySelector('[aria-label="Enable notifications"]')?.getAttribute('aria-pressed')).toBe('false')
  expect(await list()).toEqual(before)
  const slot = before.slots[0]
  expect((await originalFetch(new URL('/api/push/unsubscribe', server.url), { method: 'POST',
    headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot_id: slot.slot_id, installation_id: slot.installation_id, expected_revision: slot.revision }),
  })).status).toBe(200)
  await clickNotification('Enable notifications')
  expect(container.textContent).not.toContain('Five notification slots')
  expect(container.querySelector('[aria-label="Disable notifications"]')?.getAttribute('aria-pressed')).toBe('true')
  expect((await list()).slots).toHaveLength(5)
})

test('settings keep dead slots off and expose explicit removal before enabling again', async () => {
  mount(alice, true)
  await settle()
  await clickNotification('Enable notifications')
  const slot = (await list()).slots[0]
  // The production transition used for provider 404/410, not a fabricated browser response.
  markPushSubscriptionDead(slot.slot_id, slot.revision)
  const dead = await list()
  expect(dead.slots[0].state).toBe('repair_needed')
  render(null, container)
  mount(alice, true)
  await settle()
  expect(await list()).toEqual(dead)
  expect(container.querySelector('[aria-label="Enable notifications"]')?.getAttribute('aria-pressed')).toBe('false')
  await clickNotification('Enable notifications')
  expect(container.textContent).toContain('Remove it and explicitly enable notifications again')
  expect(await list()).toEqual(dead)
  await clickNotification('Remove notification slot')
  const removed = await list()
  expect(removed.slots).toEqual([])
  expect(removed.revocations[0]).toMatchObject({ slot_id: slot.slot_id, revision: dead.slots[0].revision + 1 })
  expect(container.textContent).not.toContain('needs repair')
  await clickNotification('Enable notifications')
  expect(container.querySelector('[aria-label="Disable notifications"]')?.getAttribute('aria-pressed')).toBe('true')
  expect((await list()).slots[0]).toMatchObject({ slot_id: slot.slot_id, state: 'active', revision: removed.revocations[0].revision + 1 })
})

test('new identity never auto-uploads a surviving subscription and ownership conflict gives an action', async () => {
  mount()
  await settle()
  expect(await current.subscribe()).toBe(true)
  const before = await list()
  render(null, container)
  mount(bob)
  await settle()
  expect((await list(bob)).slots).toEqual([])
  expect(container.textContent).toContain('off')
  expect(await current.subscribe()).toBe(false)
  await settle()
  expect(container.textContent).toContain('previous identity')
  expect(await list()).toEqual(before)
})

test('remote revocation survives reload until fresh explicit enable; cleanup failures remain off and actionable', async () => {
  mount()
  await settle()
  expect(await current.subscribe()).toBe(true)
  const slot = (await list()).slots[0]
  await originalFetch(new URL('/api/push/unsubscribe', server.url), { method: 'POST',
    headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot_id: slot.slot_id, installation_id: slot.installation_id, expected_revision: slot.revision }),
  })
  render(null, container)
  mount()
  await settle()
  expect(container.textContent).toContain('off')
  expect((await list()).slots).toEqual([])
  expect(await current.subscribe()).toBe(true)
  expect((await list()).slots[0]).toMatchObject({ slot_id: slot.slot_id, revision: 3 })
  failRemoval = true
  await current.unsubscribe()
  await settle()
  expect(container.textContent).toContain('server cleanup failed')
  expect((await list()).slots).toHaveLength(1)
  render(null, container)
  mount()
  await settle()
  expect(container.textContent).toContain('off')
  expect((await list()).slots).toHaveLength(1)
  failRemoval = false
  await current.unsubscribe()
  expect((await list()).slots).toEqual([])
})

test('explicit enable persists an owned slot across reload; disable revokes it even when browser state is gone', async () => {
  mount()
  await settle()
  expect(await current.subscribe()).toBe(true)
  await settle()
  const first = await list()
  expect(first.slots).toHaveLength(1)
  expect(container.textContent).toContain('on')
  render(null, container)
  mount(alice.toUpperCase().replace('0X', '0x'))
  await settle()
  expect((await list()).slots).toEqual(first.slots)
  expect(container.textContent).toContain('on')
  browserSub = null
  await current.unsubscribe()
  await settle()
  expect(await list()).toEqual({ slots: [], revocations: [{ slot_id: first.slots[0].slot_id,
    installation_id: first.slots[0].installation_id, revision: 2 }] })
  expect(container.textContent).toContain('off')
  render(null, container)
  mount()
  await settle()
  expect((await list()).slots).toEqual([])
  expect(container.textContent).toContain('off')
})
