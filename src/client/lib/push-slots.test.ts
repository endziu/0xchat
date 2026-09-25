import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createSession, getDb, initDb, registerPubkey } from '../../server/db'
import { createFetch } from '../../server/router'
import * as limiters from '../../server/rate-limiters'
import type { PushSlotHandle, PushSlotList } from '../../shared/push-slot'

// Superseded cleanup is decided by authoritative server state, so these run
// against the real HTTP + SQLite boundary rather than a stubbed API.
const originalFetch = globalThis.fetch
const globals = new Map(['fetch', 'Request', 'Response', 'Headers', 'URL', 'URLSearchParams', 'ReadableStream',
  'WritableStream', 'TransformStream', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'structuredClone']
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let slots: typeof import('./push-slots')
let apiModule: typeof import('./api')
let server: ReturnType<typeof Bun.serve>
const alice = `0x${'a'.repeat(40)}`
const keys = { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') }
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`
const subscription = (name: string): PushSubscriptionJSON => ({ endpoint: endpoint(name), expirationTime: null, keys })

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost' })
  for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor)
  slots = await import('./push-slots')
  apiModule = await import('./api')
})
afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  initDb(':memory:')
  registerPubkey(alice, 'test-key')
  createSession(alice, alice, Date.now() + 60_000)
  for (const limiter of Object.values(limiters)) limiter.reset()
  server = Bun.serve({ port: 0, fetch: createFetch() })
  localStorage.clear()
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, options?: RequestInit) => originalFetch(new URL(String(input), server.url), options),
    { preconnect: originalFetch.preconnect },
  )
})
afterEach(() => {
  globalThis.fetch = originalFetch
  server.stop(true)
  getDb().close()
  for (const limiter of Object.values(limiters)) limiter.reset()
})

const fresh = () => false
async function list(): Promise<PushSlotList> {
  return (await originalFetch(new URL('/api/push/subscriptions', server.url), {
    headers: { Authorization: `Bearer ${alice}` },
  })).json()
}

test('superseded cleanup removes exactly the slot that operation wrote', async () => {
  const written = await slots.enablePushSlot(alice, alice, subscription('own-write'), fresh)
  expect(written).toBeDefined()

  expect(await slots.releaseSupersededSlot(alice, alice, written, true)).toBe(true)

  expect(await list()).toEqual({ slots: [], revocations: [{ slot_id: written!.slot_id,
    installation_id: written!.installation_id, revision: written!.revision + 1 }] })
})

test('superseded cleanup leaves a registration whose revision has moved on', async () => {
  const written = await slots.enablePushSlot(alice, alice, subscription('replaced'), fresh) as PushSlotHandle
  // Another operation replaced the endpoint in the same owned slot.
  const newer = await apiModule.api.reconcilePush(subscription('replaced-again'),
    { slot_id: written.slot_id, installation_id: written.installation_id, expected_revision: written.revision }, alice)
  expect(newer.revision).toBeGreaterThan(written.revision)

  expect(await slots.releaseSupersededSlot(alice, alice, written, true)).toBe(false)

  expect((await list()).slots).toEqual([expect.objectContaining({ slot_id: written.slot_id,
    revision: newer.revision, state: 'active' })])
})

test('a superseded operation that never uploaded keeps its hands off a live registration', async () => {
  // Nothing of this operation's own reached the server; another tab's slot did.
  const other = await slots.enablePushSlot(alice, alice, subscription('other-tab'), fresh)

  expect(await slots.releaseSupersededSlot(alice, alice, undefined, true)).toBe(false)
  expect((await list()).slots).toEqual([expect.objectContaining({ slot_id: other!.slot_id })])

  await slots.removePushSlot(alice, alice, fresh)
  // With no live registration left, the browser subscription is the caller's —
  // but only because serialization rules out a concurrent tab claiming it.
  expect(await slots.releaseSupersededSlot(alice, alice, undefined, true)).toBe(true)
  expect(await slots.releaseSupersededSlot(alice, alice, undefined, false)).toBe(false)
})
