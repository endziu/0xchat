import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openingConnectionCount } from './sse.ts';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSignedMessageEnvelope } from '../client/lib/message-envelope.ts';
import { verifyDeliveredMessage } from '../shared/message-envelope.ts';
import { createSession, deleteExpiredMessages, getDb, initDb, registerPubkey } from './db.ts';
import { createFetch } from './router.ts';

function identity(byte: string) {
  const privateKey = `0x${byte.repeat(32)}` as const;
  return { privateKey, address: privateKeyToAccount(privateKey).address.toLowerCase(),
    publicKey: bytesToHex(secp.getPublicKey(hexToBytes(privateKey), true)) };
}
const alice = identity('12');
const bob = identity('23');
let server: ReturnType<typeof Bun.serve>;
let clock: ReturnType<typeof spyOn>;
let tempDirectory: string | undefined;
afterEach(() => { server?.stop(true); clock?.mockRestore(); getDb().close(); if (tempDirectory) { rmSync(tempDirectory, { recursive: true }); tempDirectory = undefined; } });

function start(newPolicy = true, path = ':memory:') {
  initDb(path);
  clock = spyOn(Date, 'now').mockReturnValue(1000);
  for (const person of [alice, bob]) {
    registerPubkey(person.address, person.publicKey);
    createSession(person.address, person.address, 1_000_000_000);
  }
  server = Bun.serve({ port: 0, fetch: createFetch(newPolicy ? { testDeliveryPolicy: 'recipient-opening' } : {}) });
}
function request(path: string, identity = bob.address, body?: unknown) {
  return fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${identity}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function send(ttl = 5) {
  const envelope = await createSignedMessageEnvelope('hello', ttl, alice, bob.address, bob.publicKey);
  const response = await request('/api/messages', alice.address, envelope);
  expect(response.status).toBe(201);
  return (await verifyDeliveredMessage(await response.json()))!;
}
function open(ids: string[], identity = bob.address) {
  return request(`/api/messages/${alice.address}/open`, identity, { ids });
}

test('real HTTP opening starts the full signed lifetime once and retries confirm it', async () => {
  start();
  const message = await send();
  expect(message.expires_at).toBe(86401000);
  clock.mockReturnValue(86400999);
  const responses = await Promise.all([open([message.id]), open([message.id])]);
  const bodies = await Promise.all(responses.map(r => r.json()));
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toEqual({ server_time: 86400999, results: [{ id: message.id, status: 'available',
    delivery_policy: 'recipient-opening', created_at: 1000, opened_at: 86400999, expires_at: 86405999 }] });
  clock.mockReturnValue(86402000);
  expect((await (await open([message.id])).json()).results).toEqual(bodies[0].results);
  const page = await (await request(`/api/messages/${alice.address}`)).json();
  expect(await verifyDeliveredMessage(page.messages[0])).toEqual({ ...message, opened_at: 86400999, expires_at: 86405999 });
  clock.mockReturnValue(86405999);
  expect((await (await open([message.id])).json()).results).toEqual([{ id: message.id, status: 'unavailable' }]);
  expect((await (await request(`/api/messages/${alice.address}`)).json()).messages).toEqual([]);
});

test('default acceptance stays legacy and opening never extends its deadline', async () => {
  start(false);
  const message = await send();
  expect(message.delivery_policy).toBe('legacy');
  expect(message.expires_at).toBe(6000);
  clock.mockReturnValue(2000);
  expect((await (await open([message.id])).json()).results[0]).toEqual({ id: message.id,
    status: 'available', delivery_policy: 'legacy', created_at: 1000, opened_at: null, expires_at: 6000 });
});

test('24-hour lifetime extends beyond retention and unopened exact expiry cannot revive', async () => {
  start();
  const opened = await send(86400);
  const expired = await send(5);
  clock.mockReturnValue(86400999);
  expect((await (await open([opened.id])).json()).results[0].expires_at).toBe(172800999);
  clock.mockReturnValue(86401000);
  expect((await (await open([expired.id])).json()).results).toEqual([{ id: expired.id, status: 'unavailable' }]);
  expect((await (await request(`/api/messages/${alice.address}`)).json()).messages.map((m: { id: string }) => m.id)).toEqual([opened.id]);
});

test('opening rejects unauthorized and malformed requests and conceals inaccessible IDs in partial batches', async () => {
  start();
  const message = await send();
  const absent = `0x${'00'.repeat(16)}`;
  expect((await open([message.id], 'invalid-session')).status).toBe(401);
  expect((await (await open([message.id], alice.address)).json()).results).toEqual([{ id: message.id, status: 'unavailable' }]);
  const wrongConversation = await request(`/api/messages/${bob.address}/open`, bob.address, { ids: [message.id] });
  expect((await wrongConversation.json()).results).toEqual([{ id: message.id, status: 'unavailable' }]);
  for (const body of [{ ids: [] }, { ids: [message.id, message.id] }, { ids: ['bad'] },
    { ids: [message.id], extra: true }, [], { ids: Array.from({ length: 101 }, (_, n) => `0x${n.toString(16).padStart(32, '0')}`) }]) {
    expect((await request(`/api/messages/${alice.address}/open`, bob.address, body)).status).toBe(400);
  }
  expect((await request(`/api/messages/${alice.address}/open`, bob.address, { ids: ['a'.repeat(4096)] })).status).toBe(413);
  const invalidJson = await fetch(new URL(`/api/messages/${alice.address}/open`, server.url), {
    method: 'POST', headers: { Authorization: `Bearer ${bob.address}` }, body: '{' });
  expect(invalidJson.status).toBe(400);
  const response = await (await open([message.id, absent])).json();
  expect(response.results).toEqual([
    { id: message.id, status: 'available', delivery_policy: 'recipient-opening', created_at: 1000, opened_at: 1000, expires_at: 6000 },
    { id: absent, status: 'unavailable' },
  ]);
});




test('pre-upgrade initialization twice preserves signed deliveries and original deadlines through HTTP', async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), '0xchat-migration-'));
  const path = join(tempDirectory, 'chat.db');
  const envelope = await createSignedMessageEnvelope('old ciphertext', 5, alice, bob.address, bob.publicKey);
  const old = new Database(path);
  old.run(`CREATE TABLE messages (
    version INTEGER NOT NULL, id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL,
    ct_recipient TEXT NOT NULL, ephemeral_pub_recipient TEXT NOT NULL, iv_recipient TEXT NOT NULL,
    ct_sender TEXT NOT NULL, ephemeral_pub_sender TEXT NOT NULL, iv_sender TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL, signature TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`);
  old.query('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    envelope.version, envelope.id, envelope.sender, envelope.recipient,
    envelope.ct_recipient, envelope.ephemeral_pub_recipient, envelope.iv_recipient,
    envelope.ct_sender, envelope.ephemeral_pub_sender, envelope.iv_sender,
    envelope.ttl, envelope.signature, 1000, 6000);
  old.close();
  start(false, path);
  const expected = { ...envelope, delivery_policy: 'legacy' as const, created_at: 1000, opened_at: null, expires_at: 6000 };
  for (let initialization = 0; initialization < 2; initialization++) {
    const page = await (await request(`/api/messages/${alice.address}`)).json();
    expect(page.messages).toEqual([expected]);
    expect(await verifyDeliveredMessage(page.messages[0])).toEqual(expected);
    expect((await (await open([envelope.id])).json()).results[0].expires_at).toBe(6000);
    if (initialization === 0) { getDb().close(); initDb(path); }
  }
  clock.mockReturnValue(6000);
  deleteExpiredMessages();
  // Turning the clock back distinguishes physical cleanup from read-time filtering.
  clock.mockReturnValue(1000);
  expect((await (await request(`/api/messages/${alice.address}`)).json()).messages).toEqual([]);
});

async function stream(address: string, capability?: string) {
  const tokenResponse = await fetch(new URL('/api/events/token', server.url), {
    method: 'POST', headers: { Authorization: `Bearer ${address}`,
      ...(capability ? { 'X-0xChat-Delivery-Capability': capability } : {}) },
  });
  expect(tokenResponse.status).toBe(200);
  const { sse_token } = await tokenResponse.json();
  const abort = new AbortController();
  const response = await fetch(new URL(`/api/events?token=${sse_token}`, server.url), { signal: abort.signal });
  const reader = response.body!.getReader();
  await reader.read(); // initial ping
  return { reader, abort };
}

test('SSE records advertised capability without enforcement and both participants receive committed metadata', async () => {
  start();
  const message = await send();
  const sender = await stream(alice.address);
  const recipient = await stream(bob.address, 'recipient-opening-v1');
  try {
    expect(openingConnectionCount(alice.address)).toBe(0);
    expect(openingConnectionCount(bob.address)).toBe(1);
    clock.mockReturnValue(2000);
    const opening = await open([message.id]);
    expect(opening.status).toBe(200);
    const chunks = await Promise.all([sender.reader.read(), recipient.reader.read()]);
    const expected = { id: message.id, sender: alice.address, recipient: bob.address,
      delivery_policy: 'recipient-opening', created_at: 1000, opened_at: 2000, expires_at: 7000 };
    for (const chunk of chunks) {
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toBe(`event: expiry-update\ndata: ${JSON.stringify(expected)}\n\n`);
    }
    const page = await (await request(`/api/messages/${alice.address}`)).json();
    expect(page.messages[0].expires_at).toBe(7000);
  } finally {
    sender.abort.abort(); recipient.abort.abort();
    await Promise.allSettled([sender.reader.cancel(), recipient.reader.cancel()]);
  }
});

test('opening accepts 100 distinct IDs and bounds sustained request volume', async () => {
  start();
  const rateIdentity = identity('34').address;
  createSession(rateIdentity, rateIdentity, 1_000_000_000);
  const ids = Array.from({ length: 100 }, (_, n) => `0x${n.toString(16).padStart(32, '0')}`);
  const response = await open(ids, rateIdentity);
  expect(response.status).toBe(200);
  expect((await response.json()).results).toHaveLength(100);
  for (let n = 1; n < 120; n++) expect((await open(ids, rateIdentity)).status).toBe(200);
  expect((await open(ids, rateIdentity)).status).toBe(429);
});
