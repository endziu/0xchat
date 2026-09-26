import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createSignedMessageEnvelope } from '../client/lib/message-envelope.ts';
import { verifyDeliveredMessage } from '../shared/message-envelope.ts';
import { createSession, getDb, initDb, registerPubkey } from './db.ts';
import { createFetch } from './router.ts';
import { LifecycleGate } from './lifecycle-gate.ts';
import { addClient, removeClient } from './sse.ts';
import * as limiters from './rate-limiters.ts';
import { identity } from './test-identity.ts';

const alice = identity('31');
const bob = identity('42');
const carol = identity('53');
let server: ReturnType<typeof Bun.serve>;
let clock: ReturnType<typeof spyOn>;

beforeEach(() => {
  for (const limiter of Object.values(limiters)) limiter.reset();
  initDb(':memory:');
  clock = spyOn(Date, 'now').mockReturnValue(1000);
  for (const person of [alice, bob, carol]) {
    registerPubkey(person.address, person.publicKey);
    createSession(person.address, person.address, 1_000_000_000);
  }
  server = Bun.serve({ port: 0, fetch: createFetch({ lifecycleGate: new LifecycleGate(true) }) });
});

afterEach(() => {
  server.stop(true);
  clock.mockRestore();
  getDb().close();
  for (const limiter of Object.values(limiters)) limiter.reset();
});

function request(path: string, identity: string, method = 'GET', body?: unknown) {
  const headers = { Authorization: `Bearer ${identity}`, 'Content-Type': 'application/json', 'X-0xChat-Delivery-Capability': 'recipient-opening-v1' };
  return fetch(new URL(path, server.url), body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) });
}
async function send(from: typeof alice, to: typeof alice, text = 'hello') {
  const envelope = await createSignedMessageEnvelope(text, 300, from, to.address, to.publicKey);
  const response = await request('/api/messages', from.address, 'POST', envelope);
  expect(response.status).toBe(201);
  return (await verifyDeliveredMessage(await response.json()))!;
}
function clear(partner: string, identity: string) {
  return request(`/api/messages/${partner}`, identity, 'DELETE');
}
function remainingIds(): string[] {
  return (getDb().query('SELECT id FROM messages ORDER BY rowid').all() as { id: string }[]).map(row => row.id);
}
function listen(address: string): { events: string[]; stop: () => void } {
  const events: string[] = [];
  let ctrl!: ReadableStreamDefaultController;
  new ReadableStream({ start(c) { ctrl = c; } });
  ctrl.enqueue = (chunk: Uint8Array) => { events.push(new TextDecoder().decode(chunk)); };
  addClient(address, ctrl);
  return { events, stop: () => removeClient(address, ctrl) };
}

test('clearing deletes both directions of one conversation and keeps other conversations', async () => {
  await send(alice, bob);
  await send(bob, alice);
  const other = await send(alice, carol);
  clock.mockReturnValue(2000);

  const response = await clear(bob.address, alice.address);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ cleared_at: 2000 });
  expect(remainingIds()).toEqual([other.id]);
});

test('either participant can clear, and a message sent afterwards is kept', async () => {
  await send(alice, bob);
  clock.mockReturnValue(2000);
  expect((await clear(alice.address.toUpperCase().replace('0X', '0x'), bob.address)).status).toBe(200);
  clock.mockReturnValue(3000);
  const later = await send(alice, bob);
  expect(remainingIds()).toEqual([later.id]);
  const page = await (await request(`/api/messages/${alice.address}`, bob.address)).json() as { messages: { id: string }[] };
  expect(page.messages.map(message => message.id)).toEqual([later.id]);
});

test('both participants hear which conversation was cleared, named by their partner', async () => {
  await send(alice, bob);
  const aliceStream = listen(alice.address);
  const bobStream = listen(bob.address);
  const carolStream = listen(carol.address);
  clock.mockReturnValue(2000);
  try {
    expect((await clear(bob.address, alice.address)).status).toBe(200);
  } finally {
    aliceStream.stop(); bobStream.stop(); carolStream.stop();
  }
  expect(aliceStream.events).toEqual([`event: conversation-cleared\ndata: ${JSON.stringify({ address: bob.address, cleared_at: 2000 })}\n\n`]);
  expect(bobStream.events).toEqual([`event: conversation-cleared\ndata: ${JSON.stringify({ address: alice.address, cleared_at: 2000 })}\n\n`]);
  expect(carolStream.events).toEqual([]);
});

test('clearing requires a session and a valid partner address', async () => {
  await send(alice, bob);
  expect((await clear(bob.address, 'invalid-session')).status).toBe(401);
  expect((await clear('0x1234', alice.address)).status).toBe(404);
  expect(remainingIds()).toHaveLength(1);
});

test('clearing is rate-limited per identity', async () => {
  for (let count = 0; count < 10; count++) expect((await clear(bob.address, alice.address)).status).toBe(200);
  expect((await clear(bob.address, alice.address)).status).toBe(429);
  expect((await clear(alice.address, bob.address)).status).toBe(200);
});
