import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { render } from 'preact'
import { getDb, initDb } from '../../server/db'
import { createFetch } from '../../server/router'
import { clientUpdateRequired } from '../../server/http'
import * as limiters from '../../server/rate-limiters'
import * as serverConstants from '../../server/constants'
import { ChatClient } from '../../cli/client'
import { parsePrivateKey } from '../../cli/identity'
import { signEIP191, type Keypair } from '../lib/burner'
import { DELIVERY_CAPABILITY, type MessageLifecycle, type OpeningResponse } from '../../shared/message-envelope'

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
let intercept: (request: Request, next: (forwarded?: Request) => Promise<Response>) => Promise<Response>
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
    return !this.closed && !this.ended && this.frames.some(frame => frame.type === 'ping')
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
    headers: { Origin: origin, Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json', 'X-0xChat-Delivery-Capability': DELIVERY_CAPABILITY },
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
    container,
    unmount,
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
  const handler = createFetch()
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request, srv) {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path.endsWith('/open')) openRequests.push((await request.clone().json()).ids)
    return intercept(request, (forwarded = request) => handler(forwarded, srv))
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

test('a selected conversation opens nothing until its window is visible and focused', async () => {
  focused = false
  const sent = await alice.send(bobKey.address, 'unattended secret', 300)
  const view = mount()
  await waitFor(() => view.text().includes('No messages yet'))
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

const OPENING_FAILED = 'Some messages could not be opened'

function notice(title: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="alert"]')].find(alert => alert.textContent?.includes(title))
}

function clickRetry(title: string): void {
  const button = notice(title)?.querySelector('button')
  if (!button) throw new Error(`No retry offered for: ${title}`)
  button.click()
}

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

const latestStream = () => TestEventSource.instances.at(-1)!
const bobAddress = bobKey.address.toLowerCase()

// The rules for what a refresh accepts are the session's; this covers the
// notice and its retry once the stream reconnects.
test('a failed refresh after reconnecting keeps changeable content hidden and offers a retry', async () => {
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
    return Response.json({ ...body, results: [] })
  }

  latestStream().drop()
  await waitFor(() => notice('Failed to load messages') !== undefined)
  expect(view.text()).not.toContain('needs a valid refresh')
  clickRetry('Failed to load messages')
  await waitFor(() => view.text().includes('needs a valid refresh'))
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

test('a visible window keeps live delivery after blur without opening unattended messages', async () => {
  const view = mount()
  await waitFor(() => streamReady() && view.text().includes('No messages yet'))
  const stream = latestStream()
  setFocused(false)
  await Bun.sleep(50)
  expect(stream.live).toBe(true)

  const sent = await alice.send(bobAddress, 'arrived while unfocused', 300)
  await waitFor(() => stream.frames.some(frame => frame.data.includes(sent.id)))
  expect(openRequests).toEqual([])
  expect(await lifecycle(sent.id)).toMatchObject({ status: 'available', opened_at: null })
})

test('focus flips report attention once settled, not per event', async () => {
  const view = mount()
  await waitFor(() => streamReady() && view.text().includes('No messages yet'))
  const reports: boolean[] = []
  intercept = async (request, next) => {
    if (new URL(request.url).pathname === '/api/events/attention') reports.push((await request.clone().json()).attentive)
    return next()
  }
  for (let flip = 0; flip < 10; flip++) setFocused(flip % 2 === 1)
  setFocused(false)
  await Bun.sleep(500)
  expect(reports).toEqual([false])

  for (let flip = 0; flip < 10; flip++) setFocused(flip % 2 === 0)
  setFocused(false)
  await Bun.sleep(500)
  expect(reports).toEqual([false])
  expect(openRequests).toEqual([])
})

test('hiding the document closes delivery immediately and a late token cannot reopen it', async () => {
  const view = mount()
  await waitFor(() => streamReady() && view.text().includes('No messages yet'))
  const stream = latestStream()
  setVisible(false)
  await waitFor(() => !stream.live)
  const mint = gate(request => new URL(request.url).pathname === '/api/events/token')
  setVisible(true)
  await waitFor(() => mint.seen())
  setVisible(false)
  const count = TestEventSource.instances.length
  mint.release()
  await Bun.sleep(150)
  expect(TestEventSource.instances.length).toBe(count)
  setVisible(true)
  await waitFor(streamReady)
})

test('recovery retains older history, its next page and the nearest surviving scroll anchor', async () => {
  for (let index = 0; index < 110; index++) await alice.send(bobAddress, `older [${index}]`, 300)
  const view = mount()
  await waitFor(() => view.text().includes('older [109]'))
  button('Load older messages').click()
  await waitFor(() => view.text().includes('older [10]'))
  const pane = document.querySelector<HTMLElement>('article')!.parentElement!
  // Happy DOM has no layout: model fixed-height rows at the DOM boundary.
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => pane.querySelectorAll('article').length * 30 })
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 90 })
  const rect = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const index = this.tagName === 'ARTICLE' ? Array.from(pane.querySelectorAll('article')).indexOf(this) : -1
    return new DOMRect(0, index < 0 ? 0 : index * 30 - pane.scrollTop, 400, 30)
  })
  try {
    pane.scrollTop = 150
    pane.dispatchEvent(new Event('scroll'))
    const anchor = pane.querySelectorAll('article')[5]!
    const neighbour = pane.querySelectorAll('article')[4]!
    const neighbourTop = neighbour.getBoundingClientRect().top
    setFocused(false)
    await alice.send(bobAddress, 'new after older history', 300)
    intercept = async (request, next) => {
      const response = await next()
      if (!new URL(request.url).pathname.endsWith('/state')) return response
      const body = await response.json() as OpeningResponse
      return Response.json({ ...body, results: body.results.map(result => result.id === anchor.getAttribute('data-message-id')
        ? { id: result.id, status: 'unavailable' } : result) })
    }
    setFocused(true)
    await waitFor(() => view.text().includes('new after older history'))
    expect(view.text()).toContain('older [10]')
    expect(neighbour.getBoundingClientRect().top).toBe(neighbourTop)
    button('Load older messages').click()
    await waitFor(() => view.text().includes('older [0]'))
    expect(view.text().split('older [10]')).toHaveLength(2)
  } finally { rect.mockRestore() }
}, 15_000)

test('attention changes during reconnect backoff neither mint early nor connect while hidden', async () => {
  const view = mount()
  await waitFor(() => streamReady() && view.text().includes('No messages yet'))
  let mints = 0
  intercept = (request, next) => {
    if (new URL(request.url).pathname === '/api/events/token') mints++
    return next()
  }
  latestStream().drop()
  await waitFor(() => !latestStream().live)
  setFocused(false)
  setVisible(false)
  setFocused(true)
  await Bun.sleep(1_100)
  expect(mints).toBe(0)
  setVisible(true)
  await waitFor(streamReady)
  latestStream().drop()
  await waitFor(() => !latestStream().live)
  setFocused(false)
  setFocused(true)
  await Bun.sleep(100)
  expect(mints).toBe(1)
  await waitFor(() => mints === 2 && streamReady())
})

test.each([false, true])('a live conversation refresh cannot abort awaited recovery (stale failure: %s)', async staleFailure => {
  const view = mount()
  await waitFor(() => streamReady() && view.text().includes('No messages yet'))
  setVisible(false)
  await waitFor(() => !latestStream().live)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let requests = 0
  intercept = async (request, next) => {
    if (new URL(request.url).pathname === '/api/conversations' && ++requests === 1) {
      const response = await next()
      await held
      return staleFailure ? Response.json({ error: 'stale failure' }, { status: 503 }) : response
    }
    return next()
  }
  setVisible(true)
  await waitFor(() => streamReady() && requests === 1)
  await alice.send(bobAddress, 'arrived during conversation refresh', 300)
  await Bun.sleep(450)
  release()
  await waitFor(() => view.text().includes('arrived during conversation refresh'))
  expect(view.text()).not.toContain('Failed to refresh conversations')
})

test('recovery preserves the pre-disconnect position even at the bottom', async () => {
  for (let index = 0; index < 5; index++) await alice.send(bobAddress, `bottom [${index}]`, 300)
  const view = mount()
  await waitFor(() => view.text().includes('bottom [4]'))
  const pane = document.querySelector<HTMLElement>('article')!.parentElement!
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => pane.querySelectorAll('article').length * 30 })
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 90 })
  const rect = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const index = this.tagName === 'ARTICLE' ? Array.from(pane.querySelectorAll('article')).indexOf(this) : -1
    return new DOMRect(0, index < 0 ? 0 : index * 30 - pane.scrollTop, 400, 30)
  })
  const scroll = spyOn(pane, 'scrollTo').mockImplementation((options?: ScrollToOptions | number) => {
    if (options && typeof options !== 'number') pane.scrollTop = Number(options.top) - pane.clientHeight
  })
  try {
    pane.scrollTop = 60
    pane.dispatchEvent(new Event('scroll'))
    setFocused(false)
    expect(latestStream().live).toBe(true)
    await alice.send(bobAddress, 'new bottom message', 300)
    setFocused(true)
    await waitFor(() => view.text().includes('new bottom message'))
    expect(pane.scrollTop).toBe(60)
  } finally { rect.mockRestore(); scroll.mockRestore() }
})

test('the update action stays outside the pane hidden on small screens while the conversation list shows', async () => {
  intercept = async (request, next) => {
    if (new URL(request.url).pathname !== '/api/events/token') return next()
    return clientUpdateRequired()
  }
  const view = mount(null)
  await waitFor(() => view.text().includes('0xChat has been updated'))
  // On small screens the responsive row hides the pane that is not selected.
  const row = view.container.querySelector('nav')!.parentElement!
  const banner = view.container.querySelector('[role="alert"]')!
  expect(row.className).toContain('max-sm:[&>:last-child]:hidden')
  expect(row.contains(banner)).toBe(false)
  expect([...banner.querySelectorAll('button')].some(b => b.textContent === 'Reload to update')).toBe(true)
})

test('a client running a cached pre-release shell recovers after reloading to update', async () => {
  const sent = await alice.send(bobKey.address, 'kept for the update', 300)
  // The pre-release shell never advertises the delivery capability.
  let cachedShell = true
  const refused: string[] = []
  intercept = async (request, next) => {
    if (!cachedShell) return next()
    const headers = new Headers(request.headers)
    headers.delete('X-0xChat-Delivery-Capability')
    const response = await next(new Request(request, { headers }))
    if (response.status === 426) refused.push(new URL(request.url).pathname)
    return response
  }
  const reload = spyOn(window.location, 'reload').mockImplementation(() => { cachedShell = false })
  try {
    const stale = mount()
    await waitFor(() => stale.text().includes('0xChat has been updated'))
    expect(refused.length).toBeGreaterThan(0)
    expect(stale.text()).not.toContain('kept for the update')
    expect(openRequests).toEqual([])
    const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Reload to update')!
    button.click()
    await waitFor(() => reload.mock.calls.length === 1)

    // The reload boots the updated shell.
    stale.unmount()
    refused.length = 0
    const updated = mount()
    await waitFor(() => updated.text().includes('kept for the update'))
    expect(openRequests).toEqual([[sent.id]])
    await waitFor(streamReady)
    await alice.send(bobKey.address, 'live after the update', 300)
    await waitFor(() => updated.text().includes('live after the update'))
    expect(updated.text()).not.toContain('0xChat has been updated')
    expect(refused).toEqual([])
  } finally { reload.mockRestore() }
})

test('a token mint rejected while hidden waits for backoff after refocus', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let mints = 0
  intercept = async (request, next) => {
    if (new URL(request.url).pathname === '/api/events/token' && ++mints === 1) {
      await held
      return Response.json({ error: 'rate limited' }, { status: 429 })
    }
    return next()
  }
  const view = mount()
  await waitFor(() => mints === 1)
  setVisible(false)
  release()
  await Bun.sleep(100)
  setVisible(true)
  await Bun.sleep(100)
  expect(mints).toBe(1)
  await waitFor(() => streamReady() && view.text().includes('No messages yet'))
  expect(mints).toBe(2)
})

test('a server requiring a newer client stops live reconnects and offers a reload to update', async () => {
  let mints = 0
  intercept = async (request, next) => {
    if (new URL(request.url).pathname !== '/api/events/token') return next()
    mints++
    return clientUpdateRequired()
  }
  const reload = spyOn(window.location, 'reload').mockImplementation(() => {})
  try {
    const view = mount()
    await waitFor(() => view.text().includes('0xChat has been updated'))
    // The first reconnect would follow a one-second backoff.
    await Bun.sleep(1_500)
    expect(mints).toBe(1)
    const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Reload to update')!
    button.click()
    await waitFor(() => reload.mock.calls.length === 1)
  } finally { reload.mockRestore() }
})

test('a conversation cleared by the partner disappears from the open view live', async () => {
  await alice.send(bobKey.address, 'before the clear', 300)
  const view = mount()
  await waitFor(() => view.text().includes('before the clear'))
  await waitFor(streamReady)

  const response = await bunFetch(`${origin}/api/messages/${bobKey.address.toLowerCase()}`, {
    method: 'DELETE', headers: { Origin: origin, Authorization: `Bearer ${aliceToken}`, 'X-0xChat-Delivery-Capability': DELIVERY_CAPABILITY },
  })
  expect(response.status).toBe(200)
  await waitFor(() => !view.text().includes('before the clear'))

  await alice.send(bobKey.address, 'after the clear', 300)
  await waitFor(() => view.text().includes('after the clear'))
})

test('the clear button takes two taps and clears the conversation for both participants', async () => {
  const sent = await alice.send(bobKey.address, 'to be cleared', 300)
  const view = mount()
  await waitFor(() => view.text().includes('to be cleared'))
  const button = () => view.container.querySelector<HTMLButtonElement>('button[aria-label$="lear conversation"]')!

  button().click()
  await Bun.sleep(50)
  expect(button().getAttribute('aria-label')).toBe('Confirm clear conversation')
  expect(await lifecycle(sent.id)).toMatchObject({ status: 'available' })

  button().click()
  await waitFor(() => !view.text().includes('to be cleared') && view.text().includes('Conversation cleared'))
  expect(await lifecycle(sent.id)).toMatchObject({ status: 'unavailable' })
})

test('the open conversation names the partner by their label and your own messages as You', async () => {
  localStorage.setItem('conversation_labels', JSON.stringify({ [aliceAddress]: 'Alice' }))
  const otherDevice = new ChatClient(origin, bobKey)
  await alice.send(bobKey.address, 'hi from alice', 300)
  await otherDevice.send(aliceAddress, 'hi from me', 300)
  const view = mount()
  await waitFor(() => view.text().includes('hi from alice') && view.text().includes('hi from me'))

  const senders = [...view.container.querySelectorAll('article .font-bold')].map(sender => sender.textContent)
  expect(senders).toEqual(['Alice', 'You'])
  expect(button('Rename Alice')).not.toBeNull()
  await otherDevice.close()
})

test('removing a conversation takes two taps and forgets its label', async () => {
  localStorage.setItem('conversation_labels', JSON.stringify({ [aliceAddress]: 'Alice' }))
  await alice.send(bobKey.address, 'before removing', 300)
  const view = mount()
  await waitFor(() => view.text().includes('before removing'))
  const listed = () => view.container.querySelector('nav li') !== null

  button('Remove conversation').click()
  await Bun.sleep(50)
  expect(view.text()).toContain('Remove and forget?')
  expect(listed()).toBe(true)

  button('Confirm remove conversation').click()
  await waitFor(() => !listed())
  expect(JSON.parse(localStorage.getItem('conversation_labels')!)).toEqual({})

  // Should the address ever write again, it comes back unnamed.
  await alice.send(bobKey.address, 'back again', 300)
  await waitFor(() => view.container.querySelector('nav li')?.textContent?.includes(aliceAddress.slice(0, 6)) ?? false)
})

test('remaining lifetimes count down while the conversation is open, without any other update', async () => {
  const view = mount()
  await waitFor(() => view.text().includes('No messages yet') && streamReady())
  await alice.send(bobKey.address, 'counting down', 300)
  await waitFor(() => view.text().includes('counting down'))
  const remaining = () => view.container.querySelector('[title^="Disappears in"]')?.textContent
  // Four or five minutes, depending on the clock skew against the server.
  expect(['4m', '5m']).toContain(remaining() ?? '')

  // Counts on the server's clock, which moves with the monotonic one.
  const start = performance.now()
  const clock = spyOn(performance, 'now').mockImplementation(() => start + 150_000)
  try {
    await waitFor(() => remaining() === '2m', 3_000)
  } finally { clock.mockRestore() }
})

test('remaining lifetimes ignore a skewed device clock', async () => {
  const view = mount()
  await waitFor(() => view.text().includes('No messages yet') && streamReady())
  await alice.send(bobKey.address, 'skewed', 300)
  await waitFor(() => view.text().includes('skewed'))
  const remaining = () => view.container.querySelector('[title^="Disappears in"]')?.textContent

  const clock = spyOn(Date, 'now').mockImplementation(() => performance.timeOrigin + performance.now() + 3_600_000)
  try {
    await Bun.sleep(1_100)
    expect(['4m', '5m']).toContain(remaining() ?? '')
  } finally { clock.mockRestore() }
})

test('a departed partner who writes again can be messaged again', async () => {
  const view = mount()
  await waitFor(() => view.text().includes('No messages yet') && streamReady())
  TestEventSource.instances.at(-1)!.replay('user:disconnected', JSON.stringify({ address: aliceAddress }))
  await waitFor(() => view.text().includes("deleted their identity. Messages can't be delivered."))
  expect(view.container.querySelector('textarea')).toBeNull()

  await alice.send(bobKey.address, 'I imported my key again', 300)
  await waitFor(() => view.container.querySelector('textarea') !== null)
  expect(view.text()).not.toContain('deleted their identity')
})
