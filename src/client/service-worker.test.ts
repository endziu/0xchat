import { describe, expect, test } from 'bun:test'

type WorkerHandler = (event: any) => void

interface TestClient {
  id: string
  url: string
  focused?: boolean
  visibilityState?: string
  focus?: () => Promise<unknown>
}

async function loadWorker(clients: TestClient[] = []) {
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
      matchAll: async () => clients,
      openWindow: async (url: string) => { opened.push(url) },
    },
  }
  const source = await Bun.file(new URL('../../public/sw.js', import.meta.url)).text()
  Function('self', source)(worker)
  return { handlers, shown, opened }
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

  test('continues to leave API requests outside worker cache handling', async () => {
    const { handlers } = await loadWorker()
    let responded = false

    handlers.get('fetch')!({ request: { method: 'GET', url: 'https://chat.example/api/sse', mode: 'cors' }, respondWith: () => { responded = true } })

    expect(responded).toBe(false)
  })
})
