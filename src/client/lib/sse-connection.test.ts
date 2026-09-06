import { beforeEach, describe, expect, test } from 'bun:test'
import { SseConnection } from './sse-connection'

/** Scriptable EventSource stand-in: tests drive open/message/error by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = []

  readyState = 0 // CONNECTING; flipped to 2 on close
  onerror: (() => void) | null = null
  readonly handlers = new Map<string, Array<(e: MessageEvent) => void>>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(fn)
    this.handlers.set(type, list)
  }

  emit(type: 'open' | 'message' | 'user:disconnected', data?: string): void {
    const event = new MessageEvent(type, { data })
    for (const fn of this.handlers.get(type) ?? []) fn(event)
  }

  /** Simulates the browser giving up (non-2xx response or dead stream). */
  fail(): void {
    this.readyState = 2
    this.onerror?.()
  }

  close(): void {
    this.readyState = 2
  }

  static reset(): void {
    FakeEventSource.instances = []
  }
}

/** Deterministic timer clock; advance() fires due callbacks in order. */
function makeClock() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout(fn: () => void, ms: number): number {
      const id = nextId++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(id: number): void {
      timers.delete(id)
    },
    advance(ms: number): void {
      const target = now + ms
      for (;;) {
        let dueId: number | null = null
        let dueAt = Infinity
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < dueAt) {
            dueAt = t.at
            dueId = id
          }
        }
        if (dueId === null) break
        now = dueAt
        const due = timers.get(dueId)!
        timers.delete(dueId)
        due.fn()
      }
      now = target
    },
  }
}

/** Token mints resolve in a microtask; flush before asserting sockets. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

interface Sut {
  clock: ReturnType<typeof makeClock>
  connection: SseConnection
  mints: number
  opened: number
  disconnected: number
  messages: unknown[]
  peersLeft: string[]
}

function makeSut(mintImpl?: () => Promise<string>): Sut {
  const clock = makeClock()
  const state = { mints: 0, opened: 0, disconnected: 0, messages: [] as unknown[], peersLeft: [] as string[] }
  const mint = mintImpl ?? (async () => `tok-${++state.mints}`)
  const connection = new SseConnection({
    getSseToken: mint,
    buildUrl: (t) => `/api/events?token=${t}`,
    onOpen: () => state.opened++,
    onDisconnect: () => state.disconnected++,
    onMessage: (data) => state.messages.push(data),
    onUserDisconnected: (address) => state.peersLeft.push(address),
    // Only the surface SseConnection touches is implemented (addEventListener
    // for open/message/user:disconnected, onerror, close()); cast accordingly.
    createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id as number),
  })
  return {
    clock,
    connection,
    get mints() { return state.mints },
    get opened() { return state.opened },
    get disconnected() { return state.disconnected },
    get messages() { return state.messages },
    get peersLeft() { return state.peersLeft },
  }
}

function lastSocket(): FakeEventSource {
  const es = FakeEventSource.instances.at(-1)!
  return es
}

beforeEach(() => {
  FakeEventSource.reset()
})

describe('SseConnection', () => {
  test('connects with a minted token and reports open', async () => {
    const sut = makeSut()
    sut.connection.connect()
    await tick()

    expect(sut.mints).toBe(1)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(lastSocket().url).toBe('/api/events?token=tok-1')

    lastSocket().emit('open')
    expect(sut.opened).toBe(1)
  })

  test('recovers from a rejected connection (cap 429) with backoff and a fresh token', async () => {
    // The P2 scenario: the first dial is rejected (non-2xx), the browser
    // would stay closed forever; the reconnect loop must re-dial on its own.
    const sut = makeSut()
    sut.connection.connect()
    await tick()
    lastSocket().fail()

    // No immediate re-dial; no disconnect fired (the socket never opened)
    expect(sut.disconnected).toBe(0)
    sut.clock.advance(999)
    await tick()
    expect(FakeEventSource.instances).toHaveLength(1)

    // After the initial 1s backoff: a fresh token, a fresh socket
    sut.clock.advance(1)
    await tick()
    expect(sut.mints).toBe(2)
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(lastSocket().url).toBe('/api/events?token=tok-2')

    // Slot freed: this dial succeeds
    lastSocket().emit('open')
    expect(sut.opened).toBe(1)
  })

  test('re-mints after a dropped open stream (the old token is already consumed)', async () => {
    const sut = makeSut()
    sut.connection.connect()
    await tick()
    lastSocket().emit('open')
    expect(sut.opened).toBe(1)

    // Mid-stream drop: the browser would auto-retry the same URL and 401
    lastSocket().fail()
    expect(sut.disconnected).toBe(1)

    sut.clock.advance(1_000)
    await tick()
    expect(sut.mints).toBe(2)
    expect(lastSocket().url).toBe('/api/events?token=tok-2')
    lastSocket().emit('open')
    expect(sut.opened).toBe(2)
  })

  test('backoff doubles per failure and caps at 30s', async () => {
    const sut = makeSut()
    sut.connection.connect()
    await tick()
    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]

    for (const delay of expectedDelays) {
      lastSocket().fail()
      sut.clock.advance(delay - 1)
      const before = FakeEventSource.instances.length
      sut.clock.advance(1)
      await tick()
      expect(FakeEventSource.instances.length).toBe(before + 1)
    }
    lastSocket().emit('open')
  })

  test('a successful open resets the backoff to the initial delay', async () => {
    const sut = makeSut()
    sut.connection.connect()
    await tick()
    lastSocket().fail()

    sut.clock.advance(1_000)
    await tick()
    lastSocket().emit('open')
    lastSocket().fail() // second failure, but backoff was reset by the open

    sut.clock.advance(999)
    const before = FakeEventSource.instances.length
    sut.clock.advance(1)
    await tick()
    expect(FakeEventSource.instances.length).toBe(before + 1)
  })

  test('retries a failed token mint (e.g. rate-limited) with backoff', async () => {
    let calls = 0
    const sut = makeSut(async () => {
      calls++
      if (calls < 3) throw new Error('Too many requests')
      return `tok-${calls}`
    })
    sut.connection.connect()
    await tick()

    expect(FakeEventSource.instances).toHaveLength(0)
    sut.clock.advance(1_000)
    await tick()
    expect(calls).toBe(2)
    sut.clock.advance(2_000)
    await tick()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(lastSocket().url).toBe('/api/events?token=tok-3')
  })

  test('close() stops recovery and is idempotent', async () => {
    const sut = makeSut()
    sut.connection.connect()
    await tick()
    lastSocket().fail() // reconnect is now pending on the clock

    sut.connection.close()
    sut.connection.close()

    sut.clock.advance(300_000)
    await tick()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(sut.mints).toBe(1)
  })

  test('close() while a mint is in flight never opens a socket', async () => {
    let resolveMint: (token: string) => void = () => {}
    const sut = makeSut(
      () =>
        new Promise<string>((resolve) => {
          resolveMint = resolve
        }),
    )
    sut.connection.connect()
    sut.connection.close()

    resolveMint('tok-1')
    await tick()
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  test('repeated error events schedule a single reconnect', async () => {
    const sut = makeSut()
    sut.connection.connect()
    await tick()
    lastSocket().fail()
    lastSocket().fail()

    sut.clock.advance(30_000)
    await tick()
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  test('delivers messages and user:disconnected events', async () => {
    const sut = makeSut()
    sut.connection.connect()
    await tick()
    lastSocket().emit('open')

    lastSocket().emit('message', JSON.stringify({ id: 'm1' }))
    lastSocket().emit('user:disconnected', JSON.stringify({ address: '0xpeer' }))

    expect(sut.messages).toEqual([{ id: 'm1' }])
    expect(sut.peersLeft).toEqual(['0xpeer'])
  })

  test('malformed event data does not break the connection', async () => {
    const sut = makeSut()
    sut.connection.connect()
    await tick()
    lastSocket().emit('open')

    lastSocket().emit('message', 'not-json')
    lastSocket().emit('user:disconnected', 'also-not-json')

    expect(sut.messages).toEqual([])
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(lastSocket().readyState).toBe(0) // still open
  })
})
