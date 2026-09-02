import { beforeAll, describe, expect, test } from 'bun:test'
import { createSession, getPushSubscriptionsForAddress, initDb } from '../db.ts'
import { pushSubscribeLimiter } from '../rate-limiters.ts'
import { noOpSchedule } from '../rate-limit.test-utils.ts'
import { handleSubscribePush } from './push.ts'
import type { Context } from '../http.ts'

const address = `0x${'a'.repeat(40)}`
const token = 'push-route-test-token'
const keys = {
  p256dh: Buffer.alloc(65, 1).toString('base64url'),
  auth: Buffer.alloc(16, 2).toString('base64url'),
}

beforeAll(() => {
  initDb(':memory:')
  createSession(token, address, Date.now() + 60_000)
  pushSubscribeLimiter.setSchedule(noOpSchedule)
})

function subscribeContext(body: unknown): Context {
  const path = '/api/push/subscribe'
  const req = new Request(`https://chat.example${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return { req, url: new URL(req.url), path, method: 'POST', ip: `push-test-${Math.random()}` }
}

describe('push subscribe route validation', () => {
  test('returns a stable code for an unsupported push service', async () => {
    const response = await handleSubscribePush(subscribeContext({
      endpoint: 'https://jmt17.google.com/fcm/send/browser-token',
      keys,
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'Unsupported push service',
      code: 'unsupported_push_service',
    })
    expect(getPushSubscriptionsForAddress(address)).toEqual([])
  })

  test.each([
    null,
    {
      endpoint: 'https://fcm.googleapis.com/fcm/send/browser-token',
      keys: { ...keys, auth: 'invalid' },
    },
  ])('keeps the generic response for malformed subscriptions: %p', async (body) => {
    const response = await handleSubscribePush(subscribeContext(body))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid push subscription' })
  })
})
