import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test'
import { createSession, initDb } from '../db.ts'
import { MAX_SSE_CONNECTIONS_PER_ADDRESS } from '../constants.ts'
import { sseTokenLimiter } from '../rate-limiters.ts'
import { noOpSchedule } from '../rate-limit.test-utils.ts'
import { createFetch } from '../router.ts'
import { connectionCount, notify } from '../sse.ts'
import { handleGetSSEToken, handleSSE, SseTokenStore } from './events.ts'
import type { Context } from '../http.ts'

const address = `0x${'b'.repeat(40)}`
const otherAddress = `0x${'c'.repeat(40)}`
const sessionToken = 'sse-route-test-token'
const otherSessionToken = 'sse-route-other-test-token'

beforeAll(() => {
  initDb(':memory:')
  createSession(sessionToken, address, Date.now() + 60_000)
  createSession(otherSessionToken, otherAddress, Date.now() + 60_000)
  sseTokenLimiter.setSchedule(noOpSchedule)
})

function makeContext(
  path: string,
  ip: string,
  init?: RequestInit,
  auth = sessionToken,
): Context {
  const req = new Request(`https://chat.example${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${auth}`,
    },
  })
  return { req, url: new URL(req.url), path, method: req.method, ip }
}

async function mintSseToken(
  ip: string,
  auth = sessionToken,
): Promise<string> {
  const res = await handleGetSSEToken(
    makeContext('/api/events/token', ip, { method: 'POST' }, auth),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { sse_token: string }
  return body.sse_token
}

/** Opens an SSE stream, consumes the initial ping, and returns the reader. */
async function openSse(ip: string, sseToken: string) {
  const res = await handleSSE(makeContext(`/api/events?token=${sseToken}`, ip))
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  return { reader, first }
}

describe('SSE route', () => {
  test('client disconnect removes the client immediately', async () => {
    const ip = `sse-test-${Math.random()}`
    const sseToken = await mintSseToken(ip)
    const { reader, first } = await openSse(ip, sseToken)
    expect(first).toContain('event: ping')
    expect(connectionCount(address)).toBe(1)

    // client is live: notifications reach it
    notify(address, 'message', { id: 'm1' })
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toContain('event: message')

    await reader.cancel()

    // cleanup happens on cancel, not on the next heartbeat or notification
    expect(connectionCount(address)).toBe(0)

    // the token was consumed on admission: replay is rejected
    const replay = await handleSSE(makeContext(`/api/events?token=${sseToken}`, ip))
    expect(replay.status).toBe(401)
    expect(await replay.json()).toEqual({ error: 'Invalid or expired token' })
  })

  test('bounds concurrent SSE connections per address', async () => {
    const ip = `sse-test-${Math.random()}`
    const connections: Array<Awaited<ReturnType<typeof openSse>>> = []
    for (let i = 0; i < MAX_SSE_CONNECTIONS_PER_ADDRESS; i++) {
      connections.push(await openSse(ip, await mintSseToken(ip)))
    }
    expect(connectionCount(address)).toBe(MAX_SSE_CONNECTIONS_PER_ADDRESS)

    const rejectedToken = await mintSseToken(ip)
    const rejected = await handleSSE(
      makeContext(`/api/events?token=${rejectedToken}`, ip),
    )
    expect(rejected.status).toBe(429)
    expect(connectionCount(address)).toBe(MAX_SSE_CONNECTIONS_PER_ADDRESS)

    // cap is per address: another address is unaffected
    const other = await openSse(ip, await mintSseToken(ip, otherSessionToken))
    expect(connectionCount(otherAddress)).toBe(1)

    // token retention: the cap rejects before consuming, so the rejected
    // token is still admitted once a slot frees (the client's reconnect loop
    // is what re-dials it in a browser)
    await connections[0]!.reader.cancel()
    const retried = await openSse(ip, rejectedToken)

    await other.reader.cancel()
    await retried.reader.cancel()
    for (const c of connections.slice(1)) await c.reader.cancel()
    expect(connectionCount(address)).toBe(0)
    expect(connectionCount(otherAddress)).toBe(0)
  })

  test('concurrent admissions honor the cap synchronously', async () => {
    const ip = `sse-test-${Math.random()}`
    const tokens = await Promise.all(
      Array.from({ length: MAX_SSE_CONNECTIONS_PER_ADDRESS + 1 }, () => mintSseToken(ip)),
    )
    const responses = await Promise.all(
      tokens.map((token) => handleSSE(makeContext(`/api/events?token=${token}`, ip))),
    )
    const statuses = responses.map((r) => r.status).sort((a, b) => a - b)
    expect(statuses).toEqual([
      ...Array(MAX_SSE_CONNECTIONS_PER_ADDRESS).fill(200),
      429,
    ])
    expect(connectionCount(address)).toBe(MAX_SSE_CONNECTIONS_PER_ADDRESS)

    await Promise.all(
      responses
        .filter((r) => r.status === 200)
        .map((r) => r.body!.getReader().cancel()),
    )
    expect(connectionCount(address)).toBe(0)
  })

  test('heartbeat timer is disposed on disconnect and cleanup is idempotent', async () => {
    const ip = `sse-test-${Math.random()}`
    jest.useFakeTimers()
    try {
      const baseline = jest.getTimerCount()
      const { reader, first } = await openSse(ip, await mintSseToken(ip))
      expect(first).toContain('event: ping')
      expect(jest.getTimerCount()).toBe(baseline + 1) // heartbeat armed

      // the heartbeat actually fires while the stream is open
      jest.advanceTimersByTime(30_000)
      const heartbeat = await reader.read()
      expect(new TextDecoder().decode(heartbeat.value)).toContain('event: ping')

      await reader.cancel()
      expect(jest.getTimerCount()).toBe(baseline) // heartbeat disposed
      expect(connectionCount(address)).toBe(0)

      // cleanup is idempotent; the disposed timer never fires again
      await reader.cancel()
      jest.advanceTimersByTime(60_000)
      expect(jest.getTimerCount()).toBe(baseline)
      expect(connectionCount(address)).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  test('rate-limits SSE token minting per ip', async () => {
    const ip = `sse-test-${Math.random()}`
    for (let i = 0; i < 10; i++) {
      await mintSseToken(ip)
    }
    const res = await handleGetSSEToken(
      makeContext('/api/events/token', ip, { method: 'POST' }),
    )
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Too many requests' })
  })
})

describe('SseTokenStore', () => {
  test('a cap-rejected token keeps its original expiry', () => {
    let now = 1_000
    const store = new SseTokenStore(30_000, () => now)
    const token = store.mint(address)

    // a cap rejection is a lookup, not a consume: the token survives it
    expect(store.lookup(token)).toBe(address)
    now += 29_999
    expect(store.lookup(token)).toBe(address)
    now += 2 // original 30s expiry, not extended by the rejection
    expect(store.lookup(token)).toBeNull()
  })

  test('consume is single-use and drops the entry', () => {
    const store = new SseTokenStore(30_000)
    const token = store.mint(address)
    expect(store.consume(token)).toBe(address)
    expect(store.consume(token)).toBeNull()
    expect(store.lookup(token)).toBeNull()
  })

  test('prune drops only expired entries', () => {
    let now = 1_000
    const store = new SseTokenStore(30_000, () => now)
    const stale = store.mint(address) // expires at 31_000
    now += 31_000
    const fresh = store.mint(otherAddress) // expires at 62_000

    store.prune()

    expect(store.lookup(stale)).toBeNull()
    expect(store.lookup(fresh)).toBe(otherAddress)
  })
})

describe('SSE over real HTTP', () => {
  let server: import('bun').Server<unknown>
  let base: string

  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: createFetch() })
    base = `http://localhost:${server.port}`
  })

  afterAll(() => {
    server.stop(true)
  })

  test('a real client disconnect frees the slot and the accepted token cannot be replayed', async () => {
    const mint = await fetch(`${base}/api/events/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    })
    expect(mint.status).toBe(200)
    const { sse_token } = (await mint.json()) as { sse_token: string }

    const ctrl = new AbortController()
    const res = await fetch(`${base}/api/events?token=${sse_token}`, {
      signal: ctrl.signal,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('event: ping')
    expect(connectionCount(address)).toBe(1)

    // events reach the client over the wire
    notify(address, 'message', { id: 'wire-1' })
    const second = new TextDecoder().decode((await reader.read()).value)
    expect(second).toContain('event: message')

    // real disconnect: abort the fetch and let the server observe it
    ctrl.abort()
    for (let i = 0; i < 100 && connectionCount(address) !== 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(connectionCount(address)).toBe(0)

    // the accepted token was consumed: replaying it over HTTP is rejected
    const replay = await fetch(`${base}/api/events?token=${sse_token}`)
    expect(replay.status).toBe(401)
    await replay.body?.cancel()
  })
})
