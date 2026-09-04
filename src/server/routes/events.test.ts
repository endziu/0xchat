import { beforeAll, describe, expect, test } from 'bun:test'
import { createSession, initDb } from '../db.ts'
import { MAX_SSE_CONNECTIONS_PER_ADDRESS } from '../constants.ts'
import { sseTokenLimiter } from '../rate-limiters.ts'
import { noOpSchedule } from '../rate-limit.test-utils.ts'
import { connectionCount, notify } from '../sse.ts'
import { handleGetSSEToken, handleSSE } from './events.ts'
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

    // freeing a slot lets the rejected token reconnect (EventSource retry path)
    await connections[0]!.reader.cancel()
    const retried = await openSse(ip, rejectedToken)

    await other.reader.cancel()
    await retried.reader.cancel()
    for (const c of connections.slice(1)) await c.reader.cancel()
    expect(connectionCount(address)).toBe(0)
    expect(connectionCount(otherAddress)).toBe(0)
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
