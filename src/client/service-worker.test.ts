import { describe, expect, test } from 'bun:test'
import { createClock, createLockManager, deferred, isSettled, loadPushWorker } from './lib/push-coordination.test-utils'
import { NATIVE_EXPIRED, workerPushManager } from './lib/push-native'

// The production JavaScript owns event-specific fields; the harness supplies them.
type WorkerHandler = (event: Record<string, unknown>) => void

interface TestClient {
  id: string
  url: string
  focused?: boolean
  visibilityState?: string
  focus?: () => Promise<unknown>
}

/** Cache contents are given as cache name → request path → body. */
async function loadWorker(clients: TestClient[] = [], cacheNames: string[] | Record<string, Record<string, string>> = []) {
  const handlers = new Map<string, WorkerHandler>()
  const shown: Array<{ title: string; options: NotificationOptions }> = []
  const opened: string[] = []
  const worker = {
    addEventListener: (type: string, handler: WorkerHandler) => handlers.set(type, handler),
    location: { origin: 'https://chat.example' },
    registration: {
      showNotification: async (title: string, options: NotificationOptions) => { shown.push({ title, options }) },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => clients,
      openWindow: async (url: string) => { opened.push(url) },
    },
  }
  const source = await Bun.file(new URL('../../public/sw.js', import.meta.url)).text()
  const fetched: string[] = []
  const cached: string[] = []
  const network = { online: true, shell: 'app shell' }
  const fetch = async (request: { url: string }) => {
    fetched.push(request.url)
    if (!network.online) throw new TypeError('Failed to fetch')
    return new Response(network.shell)
  }
  const stored = new Map(Array.isArray(cacheNames)
    ? cacheNames.map(name => [name, new Map<string, string>()])
    : Object.entries(cacheNames).map(([name, entries]) => [name, new Map(Object.entries(entries))]))
  const pending: Promise<unknown>[] = []
  const caches = {
    open: async (name: string) => ({
      put: async (key: string, response: Response) => {
        cached.push(key)
        const entries = stored.get(name) ?? new Map<string, string>()
        stored.set(name, entries)
        const body = response.text().then(text => entries.set(key, text))
        pending.push(body)
        await body
      },
    }),
    match: async (key: string) => {
      for (const entries of stored.values()) {
        const body = entries.get(key)
        if (body !== undefined) return new Response(body)
      }
      return undefined
    },
    keys: async () => [...stored.keys()],
    delete: async (name: string) => stored.delete(name),
  }
  Function('self', 'fetch', 'caches', source)(worker, fetch, caches)
  const settled = async () => { await Bun.sleep(0); await Promise.all(pending) }
  return { handlers, shown, opened, fetched, cached, stored, network, settled }
}

async function dispatch(handler: WorkerHandler, event: Record<string, unknown>) {
  let completion: Promise<unknown> | undefined
  handler({ ...event, waitUntil: (promise: Promise<unknown>) => { completion = promise } })
  await completion
}

describe('production service worker notifications', () => {
  test('always displays the fixed generic notification and ignores push payloads', async () => {
    const { handlers, shown } = await loadWorker()

    await dispatch(handlers.get('push')!, { data: { json: () => ({ title: 'Secret', url: 'https://evil.example' }) } })

    expect(shown).toEqual([{
      title: '0xChat',
      options: {
        body: 'New message', icon: '/icon-192.png', badge: '/icon-192.png', tag: '0xchat-message',
      },
    }])
  })

  test('focuses same-origin clients by focused, visible, then stable ID order', async () => {
    const focused: string[] = []
    const client = (id: string, url: string, state: Partial<TestClient> = {}): TestClient => ({
      id, url, ...state, focus: async () => { focused.push(id) },
    })
    const { handlers, opened } = await loadWorker([
      client('z-visible', 'https://chat.example/chat', { visibilityState: 'visible' }),
      client('b-focused', 'https://chat.example/chat', { focused: true }),
      client('a-focused', 'https://chat.example/chat', { focused: true }),
      client('outside', 'https://evil.example/chat', { focused: true }),
    ])
    let closed = false

    await dispatch(handlers.get('notificationclick')!, {
      notification: { data: { url: 'https://evil.example/takeover' }, close: () => { closed = true } },
    })

    expect(closed).toBe(true)
    expect(focused).toEqual(['a-focused'])
    expect(opened).toEqual([])
  })

  test.each([
    { name: 'visible before hidden', states: [
      { id: 'a-hidden', visibilityState: 'hidden' },
      { id: 'z-visible', visibilityState: 'visible' },
    ], expected: 'z-visible' },
    { name: 'code-unit ID order for visible clients', states: [
      { id: 'a', visibilityState: 'visible' },
      { id: 'Z', visibilityState: 'visible' },
    ], expected: 'Z' },
    { name: 'code-unit ID order for hidden clients', states: [
      { id: 'a', visibilityState: 'hidden' },
      { id: 'Z', visibilityState: 'hidden' },
    ], expected: 'Z' },
  ])('chooses $name regardless of enumeration order', async ({ states, expected }) => {
    for (const ordered of [states, [...states].reverse()]) {
      const focused: string[] = []
      const { handlers, opened } = await loadWorker(ordered.map(state => ({
        ...state,
        url: 'https://chat.example/chat',
        focus: async () => { focused.push(state.id) },
        navigate: () => { throw new Error('must not navigate') },
      })))
      await dispatch(handlers.get('notificationclick')!, {
        notification: { close: () => {} },
      })
      expect(focused).toEqual([expected])
      expect(opened).toEqual([])
    }
  })

  test('uses the fixed chat route when no clients exist', async () => {
    const { handlers, opened } = await loadWorker()
    await dispatch(handlers.get('notificationclick')!, {
      notification: { data: { url: 'https://evil.example' }, close: () => {} },
    })
    expect(opened).toEqual(['/chat'])
  })

  test('uses the fixed chat route when no usable same-origin client exists', async () => {
    const { handlers, opened } = await loadWorker([
      { id: 'no-focus', url: 'https://chat.example/chat' },
      { id: 'outside', url: 'https://evil.example/chat', focus: async () => {} },
      { id: 'bad-url', url: 'not a url', focus: async () => {} },
    ])

    await dispatch(handlers.get('notificationclick')!, {
      notification: { data: { url: '/chat/attacker-chosen-conversation' }, close: () => {} },
    })

    expect(opened).toEqual(['/chat'])
  })

  test.each([
    { method: 'GET', url: 'https://chat.example/api/sse' },
    { method: 'GET', url: 'https://chat.example/api/messages/0x123' },
    { method: 'GET', url: 'https://chat.example/api/session' },
    { method: 'GET', url: 'https://other.example/chat' },
    { method: 'POST', url: 'https://chat.example/chat' },
  ])('leaves $method $url outside worker handling', async (request) => {
    const { handlers, fetched, cached } = await loadWorker()
    let responded = false

    handlers.get('fetch')!({ request: { ...request, mode: 'navigate' }, respondWith: () => { responded = true } })

    expect(responded).toBe(false)
    expect(fetched).toEqual([])
    expect(cached).toEqual([])
  })

  test('handles and caches same-origin app-shell navigation', async () => {
    const { handlers, fetched, cached } = await loadWorker()
    let response: Promise<Response> | undefined
    handlers.get('fetch')!({
      request: { method: 'GET', url: 'https://chat.example/chat', mode: 'navigate' },
      respondWith: (value: Promise<Response>) => { response = value },
    })
    expect(response).toBeDefined()
    expect(await (await response)?.text()).toBe('app shell')
    expect(fetched).toEqual(['https://chat.example/chat'])
    expect(cached).toEqual(['/chat'])
  })

  test('activating the lifecycle release purges shells cached by clients that predate it', async () => {
    const previous = ['0xchat-shell-v1', '0xchat-assets-v1', '0xchat-shell-v2', '0xchat-assets-v2']
    const { handlers, stored } = await loadWorker([], previous)

    await dispatch(handlers.get('activate')!, {})

    expect([...stored]).toEqual([])
  })

  test('a shell cached before the release can no longer boot once the updated worker activates', async () => {
    const { handlers, stored, network, settled } = await loadWorker([], {
      '0xchat-shell-v2': { '/chat': 'pre-release shell' },
    })
    const navigate = async () => {
      let response: Promise<Response> | undefined
      handlers.get('fetch')!({
        request: { method: 'GET', url: 'https://chat.example/chat', mode: 'navigate' },
        respondWith: (value: Promise<Response>) => { response = value },
      })
      return (await response)?.text()
    }

    await dispatch(handlers.get('activate')!, {})
    network.shell = 'updated shell'
    expect(await navigate()).toBe('updated shell')
    await settled()
    network.online = false

    expect(await navigate()).toBe('updated shell')
    expect([...stored.keys()]).not.toContain('0xchat-shell-v2')
  })
})

// The browser's push manager as the worker sees it: one subscription per
// registration, reused by `subscribe` while it exists.
function fakeBrowserPush() {
  const state = { current: null as PushSubscription | null, subscribed: 0, unsubscribing: undefined as Promise<void> | undefined }
  const make = (endpoint: string) => ({
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: async () => {
      await state.unsubscribing
      if (state.current?.endpoint === endpoint) state.current = null
      return true
    },
  }) as unknown as PushSubscription
  const pushManager = {
    subscribe: async () => {
      state.subscribed++
      return (state.current ??= make(`https://push.example/${crypto.randomUUID()}`))
    },
    getSubscription: async () => state.current,
  } as unknown as PushManager
  // The browser dropping the subscription on its own.
  const drop = () => { state.current = null }
  return { state, pushManager, drop }
}

describe('native push calls run in the worker', () => {
  const key = { applicationServerKey: new Uint8Array([4, 1, 2]) }

  test('a call from a reloaded page waits until the closed page\'s call has settled', async () => {
    const browser = fakeBrowserPush()
    const { active, running } = await loadPushWorker({ pushManager: browser.pushManager, locks: createLockManager() })
    const closedPage = workerPushManager({ active }, () => 30_000)
    const reloadedPage = workerPushManager({ active }, () => 30_000)
    const doomed = await closedPage.subscribe(key)
    const stalled = deferred()
    browser.state.unsubscribing = stalled.promise

    // The closing page's unsubscribe never reports back to it; the worker
    // stays alive for it regardless.
    void doomed.unsubscribe()
    await Bun.sleep(5)
    const enabling = reloadedPage.subscribe(key)
    expect(await isSettled(enabling)).toBe(false)
    expect(await isSettled(Promise.all(running))).toBe(false)
    expect(browser.state.subscribed).toBe(1)

    stalled.resolve()
    const fresh = await enabling
    expect(fresh.toJSON().endpoint).not.toBe(doomed.toJSON().endpoint)
    expect(browser.state.current?.endpoint).toBe(fresh.toJSON().endpoint)
  })

  test('a call still queued when its page\'s budget runs out never starts', async () => {
    const clock = createClock()
    const browser = fakeBrowserPush()
    const { active } = await loadPushWorker({ pushManager: browser.pushManager, locks: createLockManager(), now: clock.now })
    const holder = await workerPushManager({ active }, () => 30_000).subscribe(key)
    const stalled = deferred()
    browser.state.unsubscribing = stalled.promise
    void holder.unsubscribe()
    await Bun.sleep(5)

    const late = workerPushManager({ active }, () => 30_000).subscribe(key)
    clock.advance(30_000)
    stalled.resolve()

    await expect(late).rejects.toThrow(NATIVE_EXPIRED)
    expect(browser.state.subscribed).toBe(1)
    expect(browser.state.current).toBeNull()
  })

  test('without Web Locks in the worker, calls still run one at a time', async () => {
    const browser = fakeBrowserPush()
    const { active } = await loadPushWorker({ pushManager: browser.pushManager, locks: null })
    const page = workerPushManager({ active }, () => 30_000)
    const first = await page.subscribe(key)
    const stalled = deferred()
    browser.state.unsubscribing = stalled.promise

    void first.unsubscribe()
    const lookup = page.getSubscription()
    expect(await isSettled(lookup)).toBe(false)
    stalled.resolve()
    expect(await lookup).toBeNull()
  })

  test('unsubscribe removes only the subscription the page saw', async () => {
    const browser = fakeBrowserPush()
    const { active } = await loadPushWorker({ pushManager: browser.pushManager, locks: createLockManager() })
    const page = workerPushManager({ active }, () => 30_000)
    const seen = await page.subscribe(key)
    browser.drop()
    const since = await page.subscribe(key)

    expect(await seen.unsubscribe()).toBe(false)
    expect(browser.state.current?.endpoint).toBe(since.toJSON().endpoint)
    expect(await since.unsubscribe()).toBe(true)
    // Already gone is what the page asked for.
    expect(await since.unsubscribe()).toBe(true)
  })

  test('a failed browser call is reported to the page and releases the queue', async () => {
    const browser = fakeBrowserPush()
    browser.pushManager.subscribe = async () => { throw new DOMException('Registration failed', 'AbortError') }
    const { active } = await loadPushWorker({ pushManager: browser.pushManager, locks: createLockManager() })
    const page = workerPushManager({ active }, () => 30_000)

    await expect(page.subscribe(key)).rejects.toThrow('Registration failed')
    expect(await page.getSubscription()).toBeNull()
  })

  test('a settled removal is announced to every tab, even when its page is gone', async () => {
    const channelName = `push-native-${crypto.randomUUID()}`
    const browser = fakeBrowserPush()
    const { active } = await loadPushWorker({ pushManager: browser.pushManager, locks: createLockManager(), channelName })
    const tab = new BroadcastChannel(channelName)
    const heard: unknown[] = []
    tab.addEventListener('message', (event) => heard.push(event.data))
    const page = workerPushManager({ active }, () => 30_000)

    const sub = await page.subscribe(key)
    await page.getSubscription()
    await Bun.sleep(5)
    expect(heard).toEqual([])
    await sub.unsubscribe()
    await Bun.sleep(5)
    tab.close()
    expect(heard).toEqual([{ type: 'push-state-changed' }])
  })

  test('ignores messages that are not native push requests', async () => {
    const browser = fakeBrowserPush()
    const { active, running } = await loadPushWorker({ pushManager: browser.pushManager })
    const { port2 } = new MessageChannel()

    active.postMessage({ type: 'something-else', op: 'subscribe' }, [port2])
    active.postMessage({ type: 'push-native', op: 'subscribe' })

    expect(running).toEqual([])
    expect(browser.state.subscribed).toBe(0)
  })
})
