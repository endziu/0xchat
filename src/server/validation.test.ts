import { describe, expect, test } from 'bun:test'
import { validatePushSubscription } from './validation.ts'

const keys = {
  p256dh: Buffer.alloc(65, 1).toString('base64url'),
  auth: Buffer.alloc(16, 2).toString('base64url'),
}

describe('push subscription validation', () => {
  test.each([
    ['FCM production', 'https://fcm.googleapis.com/fcm/send/browser-token'],
    ['Mozilla autopush', 'https://updates.push.services.mozilla.com/wpush/v2/browser-token'],
    ['Apple Web Push', 'https://web.push.apple.com/QHh0/browser-token'],
    ['Microsoft Edge for Windows', 'https://wns2-db5p.notify.windows.com/w/?token=desktop-pwa-token'],
  ])('accepts a %s endpoint', (_service, endpoint) => {
    expect(validatePushSubscription({ endpoint, keys }).ok).toBe(true)
  })

  test('identifies a deprecated Chromium endpoint as an unsupported host', () => {
    expect(
      validatePushSubscription({
        endpoint: 'https://jmt17.google.com/fcm/send/browser-token',
        keys,
      }),
    ).toEqual({ ok: false, reason: 'host', hostname: 'jmt17.google.com' })
  })

  test.each([
    'https://notify.windows.com.attacker.example/w/?token=desktop-pwa-token',
    'https://attacker.example/push/browser-token',
  ])('rejects a lookalike or arbitrary host: %s', (endpoint) => {
    const result = validatePushSubscription({ endpoint, keys })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('host')
  })

  test('distinguishes malformed shape, protocol, and key material', () => {
    expect(validatePushSubscription(null)).toEqual({ ok: false, reason: 'shape' })
    expect(
      validatePushSubscription({ endpoint: 'http://fcm.googleapis.com/fcm/send/token', keys }),
    ).toEqual({ ok: false, reason: 'protocol' })
    expect(
      validatePushSubscription({
        endpoint: 'https://fcm.googleapis.com/fcm/send/token',
        keys: { ...keys, p256dh: 'invalid' },
      }),
    ).toEqual({ ok: false, reason: 'p256dh' })
    expect(
      validatePushSubscription({
        endpoint: 'https://fcm.googleapis.com/fcm/send/token',
        keys: { ...keys, auth: 'invalid' },
      }),
    ).toEqual({ ok: false, reason: 'auth' })
  })
})
