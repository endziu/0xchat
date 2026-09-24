import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSignedMessageEnvelope } from '../client/lib/message-envelope.ts';
import { DELIVERY_CAPABILITY, verifyDeliveredMessage } from '../shared/message-envelope.ts';
import { createSession, getDb, getSession, initDb, registerPubkey } from './db.ts';
import { LifecycleGate } from './lifecycle-gate.ts';
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

function start(gate: LifecycleGate, path = ':memory:') {
  initDb(path);
  clock = spyOn(Date, 'now').mockReturnValue(1000);
  for (const person of [alice, bob]) {
    registerPubkey(person.address, person.publicKey);
    if (!getSession(person.address)) createSession(person.address, person.address, 1_000_000_000);
  }
  server = Bun.serve({ port: 0, fetch: createFetch({ lifecycleGate: gate }) });
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
async function send(caller: Caller, ttl = 5) {
  const envelope = await createSignedMessageEnvelope('hello', ttl, alice, bob.address, bob.publicKey);
  return request('/api/messages', caller, alice.address, envelope);
}

test('an activated gate tells old senders to update and accepts updated senders under the new policy', async () => {
  start(new LifecycleGate(true));
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

test('an activated gate rejects old read, conversation and live-token operations while updated callers proceed', async () => {
  start(new LifecycleGate(true));
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

async function openStream(caller: Caller, as = bob.address) {
  const tokenResponse = await request('/api/events/token', caller, as, {});
  expect(tokenResponse.status).toBe(200);
  const { sse_token } = await tokenResponse.json();
  return dial(sse_token);
}
async function dial(sseToken: string) {
  const abort = new AbortController();
  const response = await fetch(new URL(`/api/events?token=${sseToken}`, server.url), { signal: abort.signal });
  const reader = response.body?.getReader();
  if (response.ok) await reader!.read(); // initial ping
  return { response, reader: reader!, abort };
}
async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunk = await reader.read();
  return chunk.done ? null : new TextDecoder().decode(chunk.value);
}

test('with acceptance disabled, old callers keep legacy delivery, reads and live streams', async () => {
  start(new LifecycleGate(false));
  const live = await openStream('old');
  try {
    const sent = await send('old');
    expect(sent.status).toBe(201);
    const message = await verifyDeliveredMessage(await sent.json());
    expect(message?.delivery_policy).toBe('legacy');
    expect(await nextEvent(live.reader)).toContain(`"id":"${message!.id}"`);
    const page = await (await request(`/api/messages/${alice.address}`, 'old')).json();
    expect(page.messages.map((m: { id: string }) => m.id)).toEqual([message!.id]);
    expect((await request('/api/conversations', 'old')).status).toBe(200);
    expect((await request(`/api/messages/${alice.address}/open`, 'old', bob.address, { ids: [message!.id] })).status).toBe(200);
  } finally {
    live.abort.abort();
  }
});

test('activation rejects pre-gate tokens and closes incompatible streams before new-policy messages are published', async () => {
  const gate = new LifecycleGate(false);
  start(gate);
  const oldStream = await openStream('old');
  const updatedStream = await openStream('updated');
  const oldToken = (await (await request('/api/events/token', 'old', bob.address, {})).json()).sse_token;
  const updatedToken = (await (await request('/api/events/token', 'updated', bob.address, {})).json()).sse_token;
  try {
    gate.activate();
    expect(await nextEvent(oldStream.reader)).toBeNull();

    for (const token of [oldToken, updatedToken]) {
      const admission = await dial(token);
      expect(admission.response.status).toBe(401);
    }

    const message = await verifyDeliveredMessage(await (await send('updated')).json());
    expect(message?.delivery_policy).toBe('recipient-opening');
    expect(await nextEvent(updatedStream.reader)).toContain(`"id":"${message!.id}"`);

    const fresh = await openStream('updated');
    expect(fresh.response.status).toBe(200);
    fresh.abort.abort();
  } finally {
    oldStream.abort.abort();
    updatedStream.abort.abort();
  }
});

test('restart without acceptance stores legacy messages but keeps dual-policy reads and enforcement while new-policy data exists', async () => {
  const directory = mkdtempSync(join(tmpdir(), '0xchat-gate-'));
  const path = join(directory, 'chat.db');
  try {
    start(new LifecycleGate(true), path);
    const opening = await verifyDeliveredMessage(await (await send('updated', 60)).json());
    server.stop(true);
    clock.mockRestore();
    getDb().close();

    start(new LifecycleGate(false), path);
    const legacy = await verifyDeliveredMessage(await (await send('updated', 60)).json());
    expect(legacy?.delivery_policy).toBe('legacy');
    expect((await send('old')).status).toBe(426);
    expect((await request('/api/events/token', 'old', bob.address, {})).status).toBe(426);

    const page = await (await request(`/api/messages/${alice.address}`, 'updated')).json();
    expect(page.messages.map((m: { id: string; delivery_policy: string }) => [m.id, m.delivery_policy]))
      .toEqual([[legacy!.id, 'legacy'], [opening!.id, 'recipient-opening']]);
    clock.mockReturnValue(2000);
    const opened = await (await request(`/api/messages/${alice.address}/open`, 'updated', bob.address,
      { ids: [opening!.id, legacy!.id] })).json();
    expect(opened.results.map((r: { expires_at: number }) => r.expires_at)).toEqual([62_000, 61_000]);

    // Once the last new-policy message is gone, the server returns to legacy compatibility.
    clock.mockReturnValue(62_000);
    expect((await request('/api/conversations', 'old')).status).toBe(200);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an activated gate leaves notification cleanup and session removal open to old clients', async () => {
  start(new LifecycleGate(true));
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/gate-cleanup',
    keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 5).toString('base64url') } };
  const installation = crypto.randomUUID();
  const enabled = await request('/api/push/subscribe', 'updated', bob.address,
    { installation_id: installation, expected_revision: 0, subscription });
  expect(enabled.status).toBe(201);
  const slot = await enabled.json();

  expect((await request('/api/push/subscriptions', 'old')).status).toBe(200);
  const removed = await request('/api/push/unsubscribe', 'old', bob.address,
    { slot_id: slot.slot_id, installation_id: installation, expected_revision: slot.revision });
  expect(removed.status).toBe(200);
  expect((await request('/api/session', 'old', bob.address, undefined, 'DELETE')).status).toBe(204);
});

test('activation during an old send body rejects the send instead of storing a new-policy message', async () => {
  const gate = new LifecycleGate(false);
  start(gate);
  const envelope = await createSignedMessageEnvelope('in flight', 5, alice, bob.address, bob.publicKey);
  const encoded = new TextEncoder().encode(JSON.stringify(envelope));
  let finish!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encoded.slice(0, 10));
    finish = () => { controller.enqueue(encoded.slice(10)); controller.close(); };
  } });
  const sending = fetch(new URL('/api/messages', server.url), { method: 'POST', body,
    headers: { Authorization: `Bearer ${alice.address}`, 'Content-Type': 'application/json' } });
  await Bun.sleep(50);
  gate.activate();
  finish();
  const response = await sending;
  expect(response.status).toBe(426);
  const page = await (await request(`/api/messages/${alice.address}`, 'updated')).json();
  expect(page.messages).toEqual([]);
});
