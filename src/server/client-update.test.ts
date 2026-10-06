import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createSignedMessageEnvelope } from '../client/lib/message-envelope.ts';
import { DELIVERY_CAPABILITY, verifyDeliveredMessage } from '../shared/message-envelope.ts';
import { createSession, getDb, getSession, initDb, registerPubkey } from './db.ts';
import { createFetch } from './router.ts';
import * as limiters from './rate-limiters.ts';
import { identity } from './test-identity.ts';

const alice = identity('31');
const bob = identity('42');
let server: ReturnType<typeof Bun.serve>;
let clock: ReturnType<typeof spyOn>;

beforeEach(() => {
  for (const limiter of Object.values(limiters)) limiter.reset();
});
afterEach(() => {
  server?.stop(true);
  clock?.mockRestore();
  getDb().close();
});

function start() {
  initDb(':memory:');
  clock = spyOn(Date, 'now').mockReturnValue(1000);
  for (const person of [alice, bob]) {
    registerPubkey(person.address, person.publicKey);
    if (!getSession(person.address)) createSession(person.address, person.address, 1_000_000_000);
  }
  server = Bun.serve({ port: 0, fetch: createFetch() });
}

type Caller = 'updated' | 'old';
function request(path: string, caller: Caller, as = bob.address, body?: unknown, method?: string) {
  return fetch(new URL(path, server.url), {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${as}`, 'Content-Type': 'application/json',
      ...(caller === 'updated' ? { 'X-0xChat-Delivery-Capability': DELIVERY_CAPABILITY } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function send(caller: Caller) {
  const envelope = await createSignedMessageEnvelope('hello', 5, alice, bob.address, bob.publicKey);
  return request('/api/messages', caller, alice.address, envelope);
}

test('old senders are told to update and updated senders get recipient-opening delivery', async () => {
  start();
  const rejected = await send('old');
  expect(rejected.status).toBe(426);
  expect(await rejected.json()).toEqual({ code: 'client_update_required',
    error: 'This 0xChat client is out of date. Reload the page or update the CLI.' });

  const accepted = await send('updated');
  expect(accepted.status).toBe(201);
  const message = await verifyDeliveredMessage(await accepted.json());
  expect(message?.delivery_policy).toBe('recipient-opening');
  expect(message?.expires_at).toBe(1000 + 86_400_000);
});

test('old read, conversation and live-token operations are rejected while updated callers proceed', async () => {
  start();
  const message = await verifyDeliveredMessage(await (await send('updated')).json());
  const page = await (await request(`/api/messages/${alice.address}`, 'updated')).json();
  const operations: Array<[string, unknown?]> = [
    [`/api/messages/${alice.address}`],
    ['/api/conversations'],
    [`/api/messages/${alice.address}/open`, { ids: [message!.id] }],
    [`/api/messages/${alice.address}/state`, { ids: [message!.id] }],
    [`/api/messages/${alice.address}/recover?after=${encodeURIComponent(page.recovery_cursor)}`],
    ['/api/events/token', {}],
  ];
  for (const [path, body] of operations) {
    const old = await request(path, 'old', bob.address, body);
    expect([path, old.status]).toEqual([path, 426]);
    expect((await old.json()).code).toBe('client_update_required');
    const updated = await request(path, 'updated', bob.address, body);
    expect([path, updated.status]).toEqual([path, 200]);
  }
});

test('notification cleanup, session removal and account deletion stay open to old clients', async () => {
  start();
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/gate-cleanup',
    keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 5).toString('base64url') } };
  const enabled = await request('/api/push/subscribe', 'updated', bob.address, subscription);
  expect(enabled.status).toBe(201);

  const removed = await request('/api/push/unsubscribe', 'old', bob.address, { endpoint: subscription.endpoint });
  expect(removed.status).toBe(200);
  expect((await request('/api/session', 'old', bob.address, undefined, 'DELETE')).status).toBe(204);
  expect((await request(`/api/addresses/${alice.address}/extra`, 'old', alice.address, undefined, 'DELETE')).status).toBe(404);
  expect((await request(`/api/addresses/${alice.address}`, 'old', alice.address, undefined, 'DELETE')).status).toBe(200);
});
