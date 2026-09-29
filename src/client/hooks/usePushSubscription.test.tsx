import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { render } from 'preact'
import { createSession, getDb, getPushSubscriptionsForAddress, initDb, registerPubkey } from '../../server/db'
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
const keys = { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') }
let browserSub: PushSubscription | null
let vapidKey: string
let permission: NotificationPermission
let failRemoval: boolean
let container: HTMLElement
let push: ReturnType<typeof usePushSubscription>
let pending: Promise<unknown> | undefined

// A browser holds at most one subscription per origin, bound to the key it was made with.
function fakeSubscription(applicationServerKey: ArrayBuffer, endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`): PushSubscription {
  return { endpoint, expirationTime: null, options: { applicationServerKey, userVisibleOnly: true },
    getKey: () => null, toJSON: () => ({ endpoint, keys }),
    unsubscribe: async () => {
      if (browserSub?.endpoint === endpoint) browserSub = null
      return true
    } } as unknown as PushSubscription
}
const keyBytes = (key: string) => Uint8Array.from(Buffer.from(key, 'base64url')).buffer

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
  vapidKey = 'A'.repeat(87)
  permission = 'granted'
  failRemoval = false
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: {
    get permission() { return permission },
    requestPermission: async () => permission,
  } })
  Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} })
  const pushManager = {
    getSubscription: async () => browserSub,
    subscribe: async (options: PushSubscriptionOptionsInit) => {
      const key = (options.applicationServerKey as Uint8Array<ArrayBuffer>).buffer
      if (browserSub && Buffer.compare(Buffer.from(browserSub.options.applicationServerKey!), Buffer.from(key))) {
        throw new DOMException('A subscription with a different applicationServerKey already exists.', 'InvalidStateError')
      }
      return (browserSub ??= fakeSubscription(key))
    },
  } as unknown as PushManager
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ pushManager }) } })
  globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
    const path = String(input)
    if (path.endsWith('/vapid-public-key')) return Response.json({ publicKey: vapidKey })
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
})

function Harness({ address }: { address: string }) {
  push = usePushSubscription(address, address)
  return <SettingsModal
    identity={{ address, publicKey: 'test-key', privateKey: '1'.repeat(64) }}
    onClose={() => {}} onImport={async () => {}}
    push={{ ...push, subscribe: () => { pending = push.subscribe() }, unsubscribe: () => { pending = push.unsubscribe() } }}
  />
}
async function settle() { await Bun.sleep(50) }
async function mount(address = alice) {
  render(<ToastProvider><Harness address={address} /></ToastProvider>, container)
  await settle()
}
const notificationsSwitch = () => container.querySelector<HTMLButtonElement>('button[role="switch"]')
async function toggle(expected: 'on' | 'off') {
  const button = notificationsSwitch()
  expect(button?.getAttribute('aria-checked')).toBe(expected === 'on' ? 'false' : 'true')
  expect(button).not.toBeNull()
  pending = undefined
  button!.click()
  await pending
  await settle()
}
const endpoints = (address = alice) => getPushSubscriptionsForAddress(address).map(row => row.endpoint)
const errorText = () => container.querySelector('.text-red-400')?.textContent ?? null

test('enabling subscribes the browser, stores the endpoint and shows notifications on', async () => {
  await mount()
  await toggle('on')

  expect(browserSub).not.toBeNull()
  expect(endpoints()).toEqual([browserSub!.endpoint])
  expect(push.subscribed).toBe(true)
  expect(notificationsSwitch()?.getAttribute('aria-checked')).toBe('true')
})

test('disabling removes the browser subscription and the stored endpoint', async () => {
  await mount()
  await toggle('on')
  await toggle('off')

  expect(browserSub).toBeNull()
  expect(endpoints()).toEqual([])
  expect(push.subscribed).toBe(false)
})

test('disabling still stops alerts when the server cannot be reached', async () => {
  await mount()
  await toggle('on')
  failRemoval = true

  expect(await push.unsubscribe()).toBe(true)
  expect(browserSub).toBeNull()
  expect(errorText()).toBeNull()
})

test('a reload re-uploads an opted-in subscription the server lost', async () => {
  await mount()
  await toggle('on')
  getDb().run('DELETE FROM push_subscriptions')

  render(null, container)
  await mount()

  expect(push.subscribed).toBe(true)
  expect(endpoints()).toEqual([browserSub!.endpoint])
})

test('a subscription the current identity never opted into is removed', async () => {
  await mount()
  await toggle('on')
  const leftover = browserSub!.endpoint

  render(null, container)
  await mount(bob)

  expect(browserSub).toBeNull()
  expect(push.subscribed).toBe(false)
  expect(endpoints(bob)).toEqual([])
  // Alice's row stays until the push service rejects the dead endpoint.
  expect(endpoints()).toEqual([leftover])
})

test('a subscription made with a rotated VAPID key is removed and Enable replaces it', async () => {
  await mount()
  await toggle('on')
  const old = browserSub!.endpoint
  vapidKey = 'B'.repeat(87)

  render(null, container)
  await mount()
  expect(browserSub).toBeNull()
  expect(push.subscribed).toBe(false)

  await toggle('on')
  expect(browserSub!.endpoint).not.toBe(old)
  expect(Buffer.from(browserSub!.options.applicationServerKey!)).toEqual(Buffer.from(keyBytes(vapidKey)))
  expect(push.subscribed).toBe(true)
})

test('Enable replaces a browser subscription made with another key without a reload', async () => {
  browserSub = fakeSubscription(keyBytes('C'.repeat(87)))
  localStorage.setItem(`0xchat.push.${alice}`, JSON.stringify({ enabled: false }))
  await mount()

  await toggle('on')
  expect(push.subscribed).toBe(true)
  expect(endpoints()).toEqual([browserSub!.endpoint])
})

test('an unsupported push service is reported and leaves no browser subscription', async () => {
  const pushManager = (await navigator.serviceWorker.ready).pushManager
  pushManager.subscribe = async (options?: PushSubscriptionOptionsInit) => (browserSub = fakeSubscription(
    (options!.applicationServerKey as Uint8Array<ArrayBuffer>).buffer, 'https://jmt17.google.com/fcm/send/token'))
  await mount()

  await toggle('on')
  expect(errorText()).toContain("push service is not supported")
  expect(browserSub).toBeNull()
  expect(push.subscribed).toBe(false)
})

test('an unanswered permission prompt does not block disabling', async () => {
  await mount()
  await toggle('on')
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: {
    permission: 'default', requestPermission: () => new Promise<NotificationPermission>(() => {}),
  } })

  void push.subscribe()
  expect(await Promise.race([push.unsubscribe(), Bun.sleep(200).then(() => 'blocked')])).toBe(true)
  expect(browserSub).toBeNull()
})

test('denied permission is reported without subscribing', async () => {
  permission = 'denied'
  await mount()

  expect(await push.subscribe()).toBe(false)
  await settle()
  expect(browserSub).toBeNull()
  expect(container.textContent).toContain('Blocked')
})
