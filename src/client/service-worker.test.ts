import { describe, expect, test } from 'bun:test'

// The production JavaScript owns event-specific fields; the harness supplies them.
type WorkerHandler = (event: Record<string, unknown>) => void

interface TestClient {
  id: string
  url: string
  focused?: boolean
  visibilityState?: string
  focus?: () => Promise<unknown>
}

async function loadWorker(clients: TestClient[] = [], cacheNames: string[] = []) {
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
  const response = new Response('app shell')
  const fetch = async (request: { url: string }) => {
    fetched.push(request.url)
    return response
  }
  const stored = new Set(cacheNames)
  const caches = {
    open: async () => ({ put: async (key: string) => { cached.push(key) } }),
    match: async () => undefined,
    keys: async () => [...stored],
    delete: async (name: string) => stored.delete(name),
  }
  Function('self', 'fetch', 'caches', source)(worker, fetch, caches)
  return { handlers, shown, opened, fetched, cached, stored }
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
})
