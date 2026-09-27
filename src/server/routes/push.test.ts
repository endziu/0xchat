import { beforeEach, describe, expect, test } from 'bun:test'
import { createSession, getPushSubscriptionsForAddress, initDb, registerPubkey } from '../db.ts'
import { pushMutationLimiter } from '../rate-limiters.ts'
import { noOpSchedule } from '../rate-limit.test-utils.ts'
import { handleSubscribePush, handleUnsubscribePush } from './push.ts'
import type { Context } from '../http.ts'
import { LifecycleGate } from '../lifecycle-gate.ts'

const alice = `0x${'a'.repeat(40)}`
const bob = `0x${'b'.repeat(40)}`
const keys = {
  p256dh: Buffer.alloc(65, 1).toString('base64url'),
  auth: Buffer.alloc(16, 2).toString('base64url'),
}
const subscription = (name: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys })

beforeEach(() => {
  initDb(':memory:')
  for (const address of [alice, bob]) {
    registerPubkey(address, 'test-key')
    createSession(address, address, Date.now() + 60_000)
  }
  pushMutationLimiter.setSchedule(noOpSchedule)
  pushMutationLimiter.reset()
})

function context(path: string, body: unknown, token: string | null = alice): Context {
  const req = new Request(`https://chat.example${path}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { req, url: new URL(req.url), path, method: 'POST', ip: `push-test-${Math.random()}`, lifecycleGate: new LifecycleGate() }
}
const subscribe = (body: unknown, token?: string | null) => handleSubscribePush(context('/api/push/subscribe', body, token))
const unsubscribe = (body: unknown, token?: string | null) => handleUnsubscribePush(context('/api/push/unsubscribe', body, token))
const endpoints = (address: string) => getPushSubscriptionsForAddress(address).map(row => row.endpoint)

describe('push subscribe route', () => {
  test('stores the canonical endpoint for the session identity', async () => {
    const response = await subscribe({ endpoint: 'https://FCM.googleapis.com:443/fcm/send/one', keys })

    expect(response.status).toBe(201)
    expect(endpoints(alice)).toEqual(['https://fcm.googleapis.com/fcm/send/one'])
  })

  test('requires a session', async () => {
    expect((await subscribe(subscription('one'), null)).status).toBe(401)
    expect(endpoints(alice)).toEqual([])
  })

  test('moves an endpoint to the identity that uploaded it last', async () => {
    await subscribe(subscription('shared'), alice)
    await subscribe(subscription('shared'), bob)

    expect(endpoints(alice)).toEqual([])
    expect(endpoints(bob)).toEqual([subscription('shared').endpoint])
  })

  test('evicts the oldest subscription past five', async () => {
    for (let i = 0; i < 6; i++) {
      expect((await subscribe(subscription(`browser-${i}`))).status).toBe(201)
      await Bun.sleep(2)
    }

    expect(endpoints(alice).sort()).toEqual([1, 2, 3, 4, 5].map(i => subscription(`browser-${i}`).endpoint))
  })

  test('returns a stable code for an unsupported push service', async () => {
    const response = await subscribe({ endpoint: 'https://jmt17.google.com/fcm/send/browser-token', keys })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Unsupported push service', code: 'unsupported_push_service' })
    expect(endpoints(alice)).toEqual([])
  })

  test('rejects a body that is not a JSON object', async () => {
    const response = await subscribe(null)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid JSON object', code: 'invalid_request' })
  })

  test('keeps the generic response for malformed subscriptions', async () => {
    const response = await subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/browser-token', keys: { ...keys, auth: 'invalid' } })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid push subscription', code: 'invalid_request' })
  })

  test('rejects bodies over 8 KiB', async () => {
    const response = await subscribe(JSON.stringify({ ...subscription('big'), padding: 'x'.repeat(9000) }))
    expect(response.status).toBe(413)
  })
})

describe('push unsubscribe route', () => {
  test('removes only the session identity\'s endpoint', async () => {
    await subscribe(subscription('mine'), alice)

    expect((await unsubscribe({ endpoint: subscription('mine').endpoint }, bob)).status).toBe(200)
    expect(endpoints(alice)).toEqual([subscription('mine').endpoint])

    expect((await unsubscribe({ endpoint: subscription('mine').endpoint }, alice)).status).toBe(200)
    expect(endpoints(alice)).toEqual([])
  })

  test('requires an endpoint', async () => {
    expect((await unsubscribe({})).status).toBe(400)
  })
})
