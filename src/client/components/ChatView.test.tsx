import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { render } from 'preact'
import { getDb, initDb } from '../../server/db'
import { createFetch } from '../../server/router'
import * as limiters from '../../server/rate-limiters'
import * as serverConstants from '../../server/constants'
import { ChatClient } from '../../cli/client'
import { parsePrivateKey } from '../../cli/identity'
import { signEIP191, type Keypair } from '../lib/burner'
import type { MessageLifecycle, OpeningResponse } from '../../shared/message-envelope'

// The mounted view talks to a real in-process server over HTTP and SSE. Only
// the platform edges are replaced: happy-dom supplies the document, a
// streaming EventSource stands in for the browser's, and focus/visibility are
// driven by hand.
const BUN_GLOBALS = ['fetch', 'Request', 'Response', 'Headers', 'URL', 'URLSearchParams', 'ReadableStream',
  'WritableStream', 'TransformStream', 'TextEncoder', 'TextDecoder', 'TextDecoderStream', 'AbortController',
  'AbortSignal', 'Blob', 'File', 'FormData', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'queueMicrotask', 'performance', 'structuredClone']
const bunGlobals = new Map(BUN_GLOBALS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const bunFetch = globalThis.fetch

let ChatView: typeof import('./ChatView').ChatView
let ToastProvider: typeof import('./Toast').ToastProvider

let server: ReturnType<typeof Bun.serve>
let origin: string
let alice: ChatClient
let aliceToken: string
let bobToken: string
let openRequests: string[][]
let intercept: (request: Request, next: () => Promise<Response>) => Promise<Response>
let serverLog: ReturnType<typeof spyOn>
let focused: boolean
let visible: boolean
const aliceKey = parsePrivateKey('12'.repeat(32))
const bobKey = parsePrivateKey('34'.repeat(32))
const aliceAddress = aliceKey.address.toLowerCase()
const mounted: Array<() => void> = []

class TestEventSource {
  static instances: TestEventSource[] = []
  onerror: (() => void) | null = null
  // Every frame received, so a test can replay one as a stale duplicate.
  readonly frames: Array<{ type: string; data: string }> = []
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  private readonly abort = new AbortController()
  private closed = false

  constructor(readonly url: string) {
    TestEventSource.instances.push(this)
    void this.run()
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closed = true
    this.abort.abort()
  }

  /** Delivers a frame again, as a delayed duplicate would arrive. */
  replay(type: string, data: string): void {
    this.emit(type, data)
  }

  /** Loses the stream the way a network failure does. */
  drop(): void {
    this.abort.abort()
  }

  private emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data }))
  }

  private async run(): Promise<void> {
    try {
      const response = await fetch(this.url, { signal: this.abort.signal })
      if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`)
      this.emit('open')
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, end).split('\n')
          buffer = buffer.slice(end + 2)
          const type = frame.find(line => line.startsWith('event: '))?.slice(7) ?? 'message'
          const data = frame.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
          this.frames.push({ type, data })
          this.emit(type, data)
        }
      }
      throw new Error('SSE stream ended')
    } catch {
      this.ended = true
      if (!this.closed) this.onerror?.()
    }
  }

  private ended = false

  /** Admitted (the server pings first) and not yet lost or closed. */
  get live(): boolean {
    return !this.ended && this.frames.some(frame => frame.type === 'ping')
  }
}

/** The current view's stream is admitted, so live events will reach it. */
const streamReady = () => TestEventSource.instances.at(-1)?.live === true

async function createSession(identity: Keypair): Promise<string> {
  const post = async (path: string, body: object) => (await bunFetch(origin + path, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json()
  const { challenge, nonce } = await post('/api/auth/challenge', { address: identity.address.toLowerCase() })
  const signature = await signEIP191(challenge, identity.privateKey)
  return (await post('/api/auth/session', { address: identity.address.toLowerCase(), nonce, signature })).token
}

/** Authoritative lifecycle, read through the sender's state lookup (never opens). */
async function lifecycle(id: string): Promise<(MessageLifecycle & { status: string }) | { status: string }> {
  const response = await bunFetch(`${origin}/api/messages/${bobKey.address.toLowerCase()}/state`, {
    method: 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [id] }),
  })
  return ((await response.json()) as OpeningResponse).results[0]!
}

// Monotonic, so tests that move the shared wall clock cannot cut waits short.
// Shorter than Bun's 5 s test timeout, so failures surface inside the test.
async function waitFor(condition: () => boolean | Promise<boolean>, timeout = 3_000): Promise<void> {
  const deadline = performance.now() + timeout
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for condition')
    await Bun.sleep(10)
  }
}

function mount(recipient: string | null = aliceAddress) {
  const container = document.createElement('div')
  document.body.append(container)
  let selected = recipient
  let identity = bobKey
  let token = bobToken
  const view = () => (
    <ToastProvider>
      <ChatView recipientAddress={selected} identity={identity} token={token} navigate={() => {}} />
    </ToastProvider>
  )
  render(view(), container)
  const unmount = () => { render(null, container); container.remove() }
  mounted.push(unmount)
  return {
    text: () => container.textContent ?? '',
    select(address: string | null) { selected = address; render(view(), container) },
    switchIdentity(next: Keypair, nextToken: string, address: string) {
      identity = next
      token = nextToken
      selected = address
      render(view(), container)
    },
  }
}

function setFocused(value: boolean) {
  focused = value
  window.dispatchEvent(new Event(value ? 'focus' : 'blur'))
}

function setVisible(value: boolean) {
  visible = value
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  for (const [key, descriptor] of bunGlobals) if (descriptor) Object.defineProperty(globalThis, key, descriptor)
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const target = typeof input === 'string' && input.startsWith('/') ? origin + input : input
      const headers = new Headers(init?.headers)
      headers.set('Origin', origin)
      return bunFetch(target, { ...init, headers })
    },
    { preconnect: bunFetch.preconnect },
  )
  Object.defineProperty(globalThis, 'EventSource', { value: TestEventSource, configurable: true, writable: true })
  Object.defineProperty(document, 'visibilityState', { get: () => visible ? 'visible' : 'hidden', configurable: true })
  Object.defineProperty(document, 'hidden', { get: () => !visible, configurable: true })
  document.hasFocus = () => focused
  ;({ ChatView } = await import('./ChatView'))
  ;({ ToastProvider } = await import('./Toast'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(async () => {
  serverLog = spyOn(serverConstants, 'log').mockImplementation(() => {})
  initDb(':memory:')
  for (const limiter of Object.values(limiters)) limiter.reset()
  localStorage.clear()
  focused = true
  visible = true
  openRequests = []
  intercept = (_request, next) => next()
  const handler = createFetch({ testDeliveryPolicy: 'recipient-opening' })
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request, srv) {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path.endsWith('/open')) openRequests.push((await request.clone().json()).ids)
    return intercept(request, () => handler(request, srv))
  } })
  origin = server.url.origin
  alice = new ChatClient(origin, aliceKey)
  await alice.login()
  await new ChatClient(origin, bobKey).register()
  aliceToken = await createSession(aliceKey)
  bobToken = await createSession(bobKey)
})

afterEach(async () => {
  for (const unmount of mounted.splice(0)) unmount()
  await alice.close()
  server.stop(true)
  serverLog.mockRestore()
  getDb().close()
})

test('reveals an incoming message only after the server confirms its opening', async () => {
  const sent = await alice.send(bobKey.address, 'first secret', 300)
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  intercept = async (request, next) => {
    if (new URL(request.url).pathname.endsWith('/open')) await released
    return next()
  }
  const view = mount()
  await waitFor(() => openRequests.length === 1)
  expect(openRequests[0]).toEqual([sent.id])
  await Bun.sleep(50)
  expect(view.text()).not.toContain('first secret')

  release()
  await waitFor(() => view.text().includes('first secret'))
  expect(await lifecycle(sent.id)).toMatchObject({ status: 'available', opened_at: expect.any(Number) })
})

test('a selected conversation opens nothing until its window is visible and focused', async () => {
  focused = false
  const sent = await alice.send(bobKey.address, 'unattended secret', 300)
  const view = mount()
  await waitFor(() => view.text().includes('No messages yet') && streamReady())
  await alice.send(bobKey.address, 'live while unfocused', 300)
  await Bun.sleep(150)
  setVisible(false)
  setFocused(true)
  await Bun.sleep(150)
  expect(openRequests).toEqual([])
  expect(view.text()).not.toContain('secret')
  expect(await lifecycle(sent.id)).toMatchObject({ status: 'available', opened_at: null })

  setVisible(true)
  await waitFor(() => view.text().includes('unattended secret') && view.text().includes('live while unfocused'))
  expect(openRequests.flat()).toHaveLength(2)
  expect(await lifecycle(sent.id)).toMatchObject({ opened_at: expect.any(Number) })
})

function gate(matches: (request: Request) => boolean, when: 'before' | 'after' = 'before') {
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let seen = false
  intercept = async (request, next) => {
    if (!matches(request)) return next()
    seen = true
    if (when === 'before') await released
    const response = await next()
    if (when === 'after') await released
    return response
  }
  return { release, seen: () => seen }
}

const isOpening = (request: Request) => new URL(request.url).pathname.endsWith('/open')

test('an opening confirmed after focus is lost stays hidden until focus returns', async () => {
  const sent = await alice.send(bobKey.address, 'confirmed while away', 300)
  const opening = gate(isOpening, 'after')
  const view = mount()
  await waitFor(() => opening.seen())
  setFocused(false)
  await waitFor(async () => (await lifecycle(sent.id) as MessageLifecycle).opened_at !== null)
  opening.release()
  await Bun.sleep(150)
  expect(view.text()).not.toContain('confirmed while away')

  setFocused(true)
  await waitFor(() => view.text().includes('confirmed while away'))
  expect(openRequests).toHaveLength(1)
})

test('losing focus while messages load and decrypt prevents their opening', async () => {
  const sent = await alice.send(bobKey.address, 'loaded while away', 300)
  const history = gate(request => request.method === 'GET' && new URL(request.url).pathname === `/api/messages/${aliceAddress}`)
  const view = mount()
  await waitFor(() => history.seen())
  setFocused(false)
  history.release()
  await Bun.sleep(150)
  expect(openRequests).toEqual([])
  expect(await lifecycle(sent.id)).toMatchObject({ opened_at: null })

  setFocused(true)
  await waitFor(() => view.text().includes('loaded while away'))
})

test('switching conversations discards in-flight opening results', async () => {
  const carolKey = parsePrivateKey('56'.repeat(32))
  const carol = new ChatClient(origin, carolKey)
  await carol.login()
  await alice.send(bobKey.address, 'alice secret', 300)
  await carol.send(bobKey.address, 'carol secret', 300)
  const opening = gate(request => isOpening(request) && request.url.includes(aliceAddress))
  const view = mount()
  await waitFor(() => opening.seen())
  view.select(carolKey.address.toLowerCase())
  await waitFor(() => view.text().includes('carol secret'))
  opening.release()
  await Bun.sleep(150)
  expect(view.text()).not.toContain('alice secret')
  await carol.close()
})

test('queued openings from a previous conversation cannot consume the selected conversation messages', async () => {
  const carolKey = parsePrivateKey('56'.repeat(32))
  const carol = new ChatClient(origin, carolKey)
  await carol.login()
  await alice.send(bobKey.address, 'alice first', 300)
  await carol.send(bobKey.address, 'carol first', 300)
  let releaseAlice!: () => void
  let releaseCarol!: () => void
  const aliceGate = new Promise<void>(resolve => { releaseAlice = resolve })
  const carolGate = new Promise<void>(resolve => { releaseCarol = resolve })
  const requests: Array<{ path: string; ids: string[] }> = []
  intercept = async (request, next) => {
    if (isOpening(request)) {
      const path = new URL(request.url).pathname
      requests.push({ path, ids: (await request.clone().json()).ids })
      await (path.includes(aliceAddress) ? aliceGate : carolGate)
    }
    return next()
  }
  const view = mount()
  await waitFor(() => requests.length === 1 && streamReady())
  await alice.send(bobKey.address, 'alice queued', 300)
  await Bun.sleep(150)
  view.select(carolKey.address.toLowerCase())
  await waitFor(() => requests.length === 2)
  const pending = await carol.send(bobKey.address, 'carol queued', 300)
  await Bun.sleep(150)
  releaseAlice()
  await Bun.sleep(150)
  expect(requests.filter(request => request.path.includes(aliceAddress))).toHaveLength(1)
  releaseCarol()
  await waitFor(() => view.text().includes('carol first') && view.text().includes('carol queued'))
  expect(requests.at(-1)).toEqual({ path: `/api/messages/${carolKey.address.toLowerCase()}/open`, ids: [pending.id] })
  expect(view.text()).not.toContain('alice queued')
  await carol.close()
})

const OPENING_FAILED = 'Some messages could not be opened'

function notice(title: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="alert"]')].find(alert => alert.textContent?.includes(title))
}

function clickRetry(title: string): void {
  const button = notice(title)?.querySelector('button')
  if (!button) throw new Error(`No retry offered for: ${title}`)
  button.click()
}

test('confirmed and unavailable IDs resolve independently; failed ones stay hidden until a retry succeeds', async () => {
  const kept = await alice.send(bobKey.address, 'confirmed neighbour', 300)
  const lost = await alice.send(bobKey.address, 'needs a retry', 300)
  const gone = await alice.send(bobKey.address, 'reported unavailable', 300)
  let first = true
  intercept = async (request, next) => {
    const response = await next()
    if (!isOpening(request) || !first) return response
    first = false
    const body = await response.json() as OpeningResponse
    return Response.json({ ...body, results: body.results
      .filter(result => result.id !== lost.id)
      .map(result => result.id === gone.id ? { id: gone.id, status: 'unavailable' } : result) })
  }
  const view = mount()
  await waitFor(() => view.text().includes('confirmed neighbour'))
  expect(view.text()).not.toContain('needs a retry')
  expect(view.text()).not.toContain('reported unavailable')
  expect(notice(OPENING_FAILED)).toBeDefined()

  clickRetry(OPENING_FAILED)
  await waitFor(() => view.text().includes('needs a retry'))
  expect(view.text()).not.toContain('reported unavailable')
  expect(notice(OPENING_FAILED)).toBeUndefined()
  expect(openRequests).toEqual([[kept.id, lost.id, gone.id], [lost.id]])
})

test('an opening request failure keeps messages hidden without echoing the server error', async () => {
  await alice.send(bobKey.address, 'held back', 300)
  let failures = 1
  intercept = async (request, next) => isOpening(request) && failures-- > 0
    ? Response.json({ error: 'server says held back' }, { status: 500 })
    : next()
  const view = mount()
  await waitFor(() => notice(OPENING_FAILED) !== undefined)
  expect(view.text()).not.toContain('held back')

  clickRetry(OPENING_FAILED)
  await waitFor(() => view.text().includes('held back'))
  expect(openRequests).toHaveLength(2)
})

test('invalid envelopes are never opened and invalid confirmations never reveal plaintext', async () => {
  const valid = await alice.send(bobKey.address, 'valid neighbour', 300)
  const corrupt = await alice.send(bobKey.address, 'corrupt envelope', 300)
  intercept = async (request, next) => {
    const response = await next()
    if (request.method === 'GET' && new URL(request.url).pathname === `/api/messages/${aliceAddress}`) {
      const page = await response.json() as { messages: Array<{ id: string; signature: string }> }
      page.messages.find(message => message.id === corrupt.id)!.signature = `0x${'00'.repeat(65)}`
      return Response.json(page)
    }
    if (!isOpening(request)) return response
    // A recipient-opening confirmation must carry its opening time.
    const body = await response.json() as OpeningResponse
    return Response.json({ ...body, results: body.results.map(result => ({ ...result, opened_at: null })) })
  }
  const view = mount()
  await waitFor(() => notice(OPENING_FAILED) !== undefined)
  expect(openRequests).toEqual([[valid.id]])
  expect(view.text()).not.toContain('valid neighbour')
  expect(view.text()).not.toContain('corrupt envelope')
})

function button(label: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!found) throw new Error(`No button labelled ${label}`)
  return found
}

test('only loaded pages open: the newest page on load, older history when it loads', async () => {
  const sent = []
  for (let index = 0; index < 60; index++) sent.push(await alice.send(bobKey.address, `history ${index}`, 300))
  const view = mount()
  await waitFor(() => view.text().includes('history 59'))
  expect(openRequests).toEqual([sent.slice(10).map(message => message.id)])
  expect(await lifecycle(sent[0]!.id)).toMatchObject({ opened_at: null })

  button('Load older messages').click()
  await waitFor(() => view.text().includes('history 0'))
  expect(openRequests[1]).toEqual(sent.slice(0, 10).map(message => message.id))
  expect(await lifecycle(sent[0]!.id)).toMatchObject({ opened_at: expect.any(Number) })
}, 20_000)

test('messages received while unfocused open in batches of at most 100 once focused', async () => {
  focused = false
  const view = mount()
  await waitFor(() => view.text().includes('No messages yet') && streamReady())
  for (let index = 0; index < 101; index++) await alice.send(bobKey.address, `burst ${index}`, 300)
  await Bun.sleep(500)
  expect(openRequests).toEqual([])

  setFocused(true)
  await waitFor(() => view.text().includes('burst 0') && view.text().includes('burst 100'))
  expect(openRequests.map(ids => ids.length).sort((a, b) => b - a)).toEqual([100, 1])
}, 20_000)

const unreadDot = () => document.querySelector('[aria-label="Unread"]')

test('selecting a conversation leaves it unread until its messages are confirmed opened', async () => {
  focused = false
  await alice.send(bobKey.address, 'unread until opened', 300)
  const view = mount()
  await waitFor(() => unreadDot() !== null)

  setFocused(true)
  await waitFor(() => view.text().includes('unread until opened'))
  await waitFor(() => unreadDot() === null)

  // Your own messages, even from another device, never make it unread.
  const otherDevice = new ChatClient(origin, bobKey)
  await otherDevice.send(aliceAddress, 'my own words', 300)
  await waitFor(() => view.text().includes('my own words'))
  await Bun.sleep(400) // the conversation list refresh is debounced
  expect(unreadDot()).toBeNull()
  await otherDevice.close()
})

test('a failed opening keeps the conversation unread until a retry succeeds', async () => {
  await alice.send(bobKey.address, 'still unread', 300)
  let failures = 1
  intercept = (request, next) => isOpening(request) && failures-- > 0
    ? Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 }))
    : next()
  const view = mount()
  await waitFor(() => notice(OPENING_FAILED) !== undefined && unreadDot() !== null)

  clickRetry(OPENING_FAILED)
  await waitFor(() => view.text().includes('still unread'))
  await waitFor(() => unreadDot() === null)
})

/** Opens a message the way another client of `token`'s identity would. */
async function openAs(token: string, counterparty: string, id: string): Promise<void> {
  const response = await bunFetch(`${origin}/api/messages/${counterparty}/open`, {
    method: 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [id] }),
  })
  expect(response.status).toBe(200)
}

const latestStream = () => TestEventSource.instances.at(-1)!
const bobAddress = bobKey.address.toLowerCase()

test("a sender copy takes the deadline set by the recipient's opening", async () => {
  const otherDevice = new ChatClient(origin, bobKey)
  const view = mount()
  await waitFor(() => view.text().includes('No messages yet') && streamReady())
  const sent = await otherDevice.send(aliceAddress, 'five seconds after opening', 5)
  await waitFor(() => view.text().includes('five seconds after opening'))

  await openAs(aliceToken, bobAddress, sent.id)
  const openedAt = performance.now()
  await waitFor(() => !view.text().includes('five seconds after opening'), 8_000)
  expect(performance.now() - openedAt).toBeGreaterThan(4_000)
  await otherDevice.close()
}, 15_000)

test('stale deliveries cannot undo an opening or revive an expired message', async () => {
  const start = Date.now()
  let elapsed = 0
  const clock = spyOn(Date, 'now').mockImplementation(() => start + elapsed)
  const monotonicNow = performance.now.bind(performance)
  const monotonicClock = spyOn(performance, 'now').mockImplementation(() => monotonicNow() + elapsed)
  try {
    const otherDevice = new ChatClient(origin, bobKey)
    const view = mount()
    await waitFor(() => view.text().includes('No messages yet') && streamReady())
    const sent = await otherDevice.send(aliceAddress, 'opened once', 5)
    await waitFor(() => view.text().includes('opened once'))
    const stale = latestStream().frames.find(frame => frame.type === 'message' && frame.data.includes(sent.id))!

    await openAs(aliceToken, bobAddress, sent.id)
    await waitFor(() => latestStream().frames.some(frame => frame.type === 'expiry-update'))
    latestStream().replay('message', stale.data)
    await Bun.sleep(100)
    expect(view.text()).toContain('opened once')

    // Background timers can run late: regaining focus re-checks expiry.
    setFocused(false)
    await Bun.sleep(50)
    elapsed = 5_000
    setFocused(true)
    await waitFor(() => !view.text().includes('opened once'))
    latestStream().replay('message', stale.data)
    await Bun.sleep(100)
    expect(view.text()).not.toContain('opened once')
    await otherDevice.close()
  } finally {
    clock.mockRestore()
    monotonicClock.mockRestore()
  }
})

test('opening visibility and focus expiry use server time despite wall-clock jumps', async () => {
  focused = false
  await alice.send(bobKey.address, 'server-clock secret', 5)
  let refreshed = false
  let localOffset = 0
  let elapsed = 0
  const wallNow = Date.now.bind(Date)
  const monotonicNow = performance.now.bind(performance)
  const clock = spyOn(Date, 'now').mockImplementation(() => wallNow() + localOffset)
  const monotonicClock = spyOn(performance, 'now').mockImplementation(() => monotonicNow() + elapsed)
  try {
    intercept = async (request, next) => {
      const response = await next()
      if (new URL(request.url).pathname.endsWith('/state')) refreshed = true
      if (isOpening(request)) localOffset = 3_600_000
      return response
    }
    const view = mount()
    await waitFor(() => refreshed && streamReady())
    await Bun.sleep(50)
    setFocused(true)
    await waitFor(() => view.text().includes('server-clock secret'))
    setFocused(false)
    await Bun.sleep(50)
    localOffset = -3_600_000
    elapsed = 5_000
    setFocused(true)
    await waitFor(() => !view.text().includes('server-clock secret'))
  } finally {
    clock.mockRestore()
    monotonicClock.mockRestore()
  }
})

test('an opening from another device does not reveal plaintext this browser has not confirmed', async () => {
  focused = false
  const sent = await alice.send(bobKey.address, 'opened elsewhere', 300)
  const view = mount()
  await waitFor(() => view.text().includes('No messages yet') && streamReady())
  await openAs(await createSession(bobKey), aliceAddress, sent.id)
  await waitFor(() => latestStream().frames.some(frame => frame.type === 'expiry-update'))
  await Bun.sleep(100)
  expect(view.text()).not.toContain('opened elsewhere')

  setFocused(true)
  await waitFor(() => view.text().includes('opened elsewhere'))
  expect(openRequests).toEqual([[sent.id], [sent.id]])
})

const HOUR = 3_600_000

test('changeable deadlines hide while out of sync and return only after an authoritative refresh', async () => {
  const start = Date.now()
  let offset = -2 * HOUR
  const clock = spyOn(Date, 'now').mockImplementation(() => start + offset)
  try {
    const otherDevice = new ChatClient(origin, bobKey)
    await alice.send(bobKey.address, 'final once opened', 86400)
    const copy = await otherDevice.send(aliceAddress, 'awaiting her opening', 86400)
    offset = 0
    await otherDevice.send(aliceAddress, 'still unopened', 86400)
    await otherDevice.close()
    const view = mount()
    const shows = (text: string) => view.text().includes(text)
    await waitFor(() => shows('final once opened') && shows('awaiting her opening') && shows('still unopened') && streamReady())

    let dropped = false
    let stateRequested = false
    let releaseMint!: () => void
    let releaseStates!: () => void
    const mint = new Promise<void>(resolve => { releaseMint = resolve })
    const states = new Promise<void>(resolve => { releaseStates = resolve })
    intercept = async (request, next) => {
      const path = new URL(request.url).pathname
      if (dropped && path === '/api/events/token') await mint
      if (path.endsWith('/state')) {
        stateRequested = true
        await states
      }
      return next()
    }
    dropped = true
    latestStream().drop()
    await waitFor(() => !shows('awaiting her opening') && !shows('still unopened'))
    expect(shows('final once opened')).toBe(true)

    // Opened elsewhere while this browser is out of sync; then the copy's
    // old unopened deadline passes locally before anything reconnects.
    offset = 21 * HOUR
    await openAs(aliceToken, bobAddress, copy.id)
    offset = 23 * HOUR
    // Refocusing sweeps expired messages; the copy must survive it hidden.
    setFocused(false)
    await Bun.sleep(50)
    setFocused(true)
    await Bun.sleep(50)

    // An open transport alone restores nothing that could have changed.
    releaseMint()
    await waitFor(() => stateRequested, 5_000)
    await Bun.sleep(100)
    expect(shows('awaiting her opening')).toBe(false)
    expect(shows('still unopened')).toBe(false)

    releaseStates()
    await waitFor(() => shows('awaiting her opening') && shows('still unopened'))
    expect(shows('final once opened')).toBe(true)
  } finally {
    clock.mockRestore()
  }
}, 15_000)

test('messages arriving while an opening is in flight share the next request', async () => {
  const first = await alice.send(bobKey.address, 'first of a burst', 300)
  const opening = gate(isOpening)
  const view = mount()
  await waitFor(() => opening.seen() && streamReady())
  const followers = []
  for (let index = 0; index < 5; index++) followers.push(await alice.send(bobKey.address, `burst follower ${index}`, 300))
  await Bun.sleep(200)

  opening.release()
  await waitFor(() => view.text().includes('first of a burst') && view.text().includes('burst follower 4'))
  expect(openRequests).toEqual([[first.id], followers.map(message => message.id)])
})

test('forged or malformed expiry updates are ignored', async () => {
  const start = Date.now()
  let elapsed = 0
  const clock = spyOn(Date, 'now').mockImplementation(() => start + elapsed)
  try {
    const otherDevice = new ChatClient(origin, bobKey)
    const view = mount()
    await waitFor(() => view.text().includes('No messages yet') && streamReady())
    const sent = await otherDevice.send(aliceAddress, 'keeps its deadline', 5)
    await otherDevice.close()
    await waitFor(() => view.text().includes('keeps its deadline'))

    // Each would expire the copy five seconds after sending if it applied.
    const opened = { id: sent.id, sender: bobAddress, recipient: aliceAddress, delivery_policy: 'recipient-opening',
      created_at: sent.created_at, opened_at: sent.created_at, expires_at: sent.created_at + 5_000 }
    const stream = latestStream()
    stream.replay('expiry-update', JSON.stringify({ ...opened, sender: `0x${'ab'.repeat(20)}` }))
    stream.replay('expiry-update', JSON.stringify({ ...opened, extra: true }))
    stream.replay('expiry-update', JSON.stringify({ ...opened, expires_at: opened.expires_at - 1 }))
    stream.replay('expiry-update', '"junk"')
    setFocused(false)
    await Bun.sleep(50)
    elapsed = 6_000
    setFocused(true)
    await Bun.sleep(100)
    expect(view.text()).toContain('keeps its deadline')
  } finally {
    clock.mockRestore()
  }
})

test.each(['missing result', 'different acceptance', 'different policy'])(
  'an invalid state refresh (%s) keeps changeable content hidden and offers a retry', async invalid => {
  const otherDevice = new ChatClient(origin, bobKey)
  await otherDevice.send(aliceAddress, 'needs a valid refresh', 300)
  await otherDevice.close()
  const view = mount()
  await waitFor(() => view.text().includes('needs a valid refresh') && streamReady())
  let corrupt = true
  intercept = async (request, next) => {
    const response = await next()
    if (!corrupt || !new URL(request.url).pathname.endsWith('/state')) return response
    corrupt = false
    const body = await response.json() as OpeningResponse
    return Response.json({ ...body, results: invalid === 'missing result' ? [] : body.results.map(result => {
      if (result.status !== 'available') return result
      return invalid === 'different acceptance'
        ? { ...result, created_at: result.created_at - 1, expires_at: result.expires_at - 1 }
        : { ...result, delivery_policy: 'legacy', expires_at: result.created_at + 300_000 }
    }) })
  }

  latestStream().drop()
  await waitFor(() => notice('Failed to load messages') !== undefined)
  expect(view.text()).not.toContain('needs a valid refresh')
  clickRetry('Failed to load messages')
  await waitFor(() => view.text().includes('needs a valid refresh'))
})

test('messages arriving in the final refresh round keep synchronization pending until retry', async () => {
  const otherDevice = new ChatClient(origin, bobKey)
  await otherDevice.send(aliceAddress, 'original sender copy', 300)
  const view = mount()
  await waitFor(() => view.text().includes('original sender copy') && streamReady())
  let rounds = 0
  intercept = async (request, next) => {
    const response = await next()
    if (new URL(request.url).pathname.endsWith('/state') && rounds < 3) {
      rounds++
      await otherDevice.send(aliceAddress, `copy during round ${rounds}`, 300)
      await Bun.sleep(150)
    }
    return response
  }
  latestStream().drop()
  await waitFor(() => notice('Failed to load messages') !== undefined)
  expect(rounds).toBe(3)
  expect(view.text()).not.toContain('original sender copy')
  expect(view.text()).not.toContain('copy during round 3')
  clickRetry('Failed to load messages')
  await waitFor(() => view.text().includes('original sender copy') && view.text().includes('copy during round 3'))
  await otherDevice.close()
})

test('switching identity discards in-flight opening results', async () => {
  const carolKey = parsePrivateKey('56'.repeat(32))
  const carol = new ChatClient(origin, carolKey)
  await carol.login()
  const carolToken = await createSession(carolKey)
  await alice.send(bobKey.address, 'for bob only', 300)
  await alice.send(carolKey.address, 'for carol', 300)
  const opening = gate(request => isOpening(request) && request.headers.get('Authorization') === `Bearer ${bobToken}`)
  const view = mount()
  await waitFor(() => opening.seen())

  view.switchIdentity(carolKey, carolToken, aliceAddress)
  await waitFor(() => view.text().includes('for carol'))
  opening.release()
  await Bun.sleep(150)
  expect(view.text()).not.toContain('for bob only')
  await carol.close()
})
