import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSignedMessageEnvelope } from '../client/lib/message-envelope.ts';
import { verifyDeliveredMessage } from '../shared/message-envelope.ts';
import { createSession, deleteExpiredMessages, getDb, initDb, registerPubkey } from './db.ts';
import { createFetch } from './router.ts';
import * as limiters from './rate-limiters.ts';

function identity(byte: string) {
  const privateKey = `0x${byte.repeat(32)}` as const;
  return { privateKey, address: privateKeyToAccount(privateKey).address.toLowerCase(),
    publicKey: bytesToHex(secp.getPublicKey(hexToBytes(privateKey), true)) };
}
const alice = identity('12');
const bob = identity('23');
const carol = identity('34');
let server: ReturnType<typeof Bun.serve>;
let clock: ReturnType<typeof spyOn>;
let directory: string | undefined;
beforeEach(() => {
  initDb(':memory:');
  clock = spyOn(Date, 'now').mockReturnValue(1000);
  for (const limiter of Object.values(limiters)) limiter.reset();
  for (const person of [alice, bob, carol]) {
    registerPubkey(person.address, person.publicKey);
    createSession(person.address, person.address, 1_000_000_000);
  }
  server = Bun.serve({ port: 0, fetch: createFetch({ testDeliveryPolicy: 'recipient-opening' }) });
});
afterEach(() => {
  server?.stop(true);
  clock.mockRestore();
  getDb().close();
  if (directory) rmSync(directory, { recursive: true });
  directory = undefined;
  for (const limiter of Object.values(limiters)) limiter.reset();
});
function request(suffix = '', address = bob.address, body?: unknown, partner = alice.address) {
  return fetch(new URL(`/api/messages/${partner}${suffix}`, server.url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${address}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function send(ttl = 5) {
  const envelope = await createSignedMessageEnvelope('hello', ttl, alice, bob.address, bob.publicKey);
  const response = await fetch(new URL('/api/messages', server.url), {
    method: 'POST', headers: { Authorization: `Bearer ${alice.address}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  expect(response.status).toBe(201);
  return (await verifyDeliveredMessage(await response.json()))!;
}
async function recover(query: string) {
  const response = await request(`/recover?${query}`);
  expect(response.status).toBe(200);
  return response.json();
}

test('recovers an entire equal-timestamp interval while concurrent later sends stay outside its bound', async () => {
  const initial = await (await request()).json();
  expect(typeof initial.recovery_cursor).toBe('string');
  const sent = [];
  for (let n = 0; n < 105; n++) sent.push(await send());
  const first = await recover(`after=${initial.recovery_cursor}`);
  expect(first.messages).toEqual(sent.slice(0, 100));
  expect(first.exhausted).toBe(false);
  expect(first.recovery_cursor).toBeNull();
  expect(typeof first.next_cursor).toBe('string');
  const live = await Promise.all([send(), send()]);
  const last = await recover(`cursor=${first.next_cursor}`);
  expect(last.messages).toEqual(sent.slice(100));
  expect(last.exhausted).toBe(true);
  expect(last.next_cursor).toBeNull();
  expect(typeof last.recovery_cursor).toBe('string');
  const later = await recover(`after=${last.recovery_cursor}`);
  expect(new Set(later.messages.map((m: { id: string }) => m.id))).toEqual(new Set(live.map(m => m.id)));
  expect(later.exhausted).toBe(true);
});

test('lifecycle lookup serves both participants without opening and conceals other conversations', async () => {
  const message = await send();
  const absent = `0x${'00'.repeat(16)}`;
  const expected = { id: message.id, status: 'available', delivery_policy: 'recipient-opening',
    created_at: 1000, opened_at: null, expires_at: 86401000 };
  for (const [address, partner] of [[bob.address, alice.address], [alice.address, bob.address]]) {
    const response = await request('/state', address, { ids: [message.id, absent] }, partner);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ server_time: 1000, results: [expected, { id: absent, status: 'unavailable' }] });
  }
  for (const [address, partner] of [[carol.address, alice.address], [bob.address, carol.address]]) {
    const response = await request('/state', address, { ids: [message.id] }, partner);
    expect((await response.json()).results).toEqual([{ id: message.id, status: 'unavailable' }]);
  }
  clock.mockReturnValue(2000);
  await request('/open', bob.address, { ids: [message.id] });
  expect((await (await request('/state', alice.address, { ids: [message.id] }, bob.address)).json()).results)
    .toEqual([{ ...expected, opened_at: 2000, expires_at: 7000 }]);
  clock.mockReturnValue(7000);
  expect((await (await request('/state', bob.address, { ids: [message.id] })).json()).results)
    .toEqual([{ id: message.id, status: 'unavailable' }]);
});


test('expired and deleted page boundaries do not invalidate progress or admit later sends', async () => {
  const initial = await (await request()).json();
  const messages = [];
  for (let n = 0; n < 102; n++) messages.push(await send());
  const first = await recover(`after=${initial.recovery_cursor}`);
  await request('/open', bob.address, { ids: [messages[99]!.id, messages[101]!.id] });
  clock.mockReturnValue(6000);
  const expired = await recover(`cursor=${first.next_cursor}`);
  expect(expired.messages).toEqual([messages[100]]);
  expect(expired.exhausted).toBe(true);
  deleteExpiredMessages();
  const later = await send();
  const deleted = await recover(`cursor=${first.next_cursor}`);
  expect(deleted.messages).toEqual([messages[100]]);
  expect(deleted.recovery_cursor).toBe(expired.recovery_cursor);
  expect((await recover(`after=${deleted.recovery_cursor}`)).messages).toEqual([later]);
  await request('/open', bob.address, { ids: [messages[100]!.id] });
  clock.mockReturnValue(11000);
  deleteExpiredMessages();
  expect((await recover(`cursor=${first.next_cursor}`)).messages).toEqual([]);
  expect((await recover(`cursor=${first.next_cursor}`)).exhausted).toBe(true);
});

test('migration preserves old timestamp/tie cursors and envelopes; checkpoints survive deletion and restart', async () => {
  server.stop(true);
  getDb().close();
  directory = mkdtempSync(join(tmpdir(), '0xchat-recovery-'));
  const path = join(directory, 'chat.db');
  const old = new Database(path);
  old.run(`CREATE TABLE messages (
    version INTEGER NOT NULL, id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL,
    ct_recipient TEXT NOT NULL, ephemeral_pub_recipient TEXT NOT NULL, iv_recipient TEXT NOT NULL,
    ct_sender TEXT NOT NULL, ephemeral_pub_sender TEXT NOT NULL, iv_sender TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL, signature TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`);
  const expected = [];
  for (const stamp of [1000, 900, 1000]) {
    const envelope = await createSignedMessageEnvelope('pre-upgrade', 5, alice, bob.address, bob.publicKey);
    old.query('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      envelope.version, envelope.id, envelope.sender, envelope.recipient,
      envelope.ct_recipient, envelope.ephemeral_pub_recipient, envelope.iv_recipient,
      envelope.ct_sender, envelope.ephemeral_pub_sender, envelope.iv_sender,
      envelope.ttl, envelope.signature, stamp, stamp + 5000);
    expected.push({ ...envelope, delivery_policy: 'legacy', created_at: stamp, opened_at: null, expires_at: stamp + 5000 });
  }
  old.close();
  initDb(path);
  for (const person of [alice, bob]) {
    registerPubkey(person.address, person.publicKey);
    createSession(person.address, person.address, 1_000_000_000);
  }
  server = Bun.serve({ port: 0, fetch: createFetch() });
  const initial = await (await request('?limit=1')).json();
  expect(initial.messages).toEqual([expected[2]]);
  // This (timestamp,rowid) cursor was issued by the old implementation.
  expect((await (await request('?before=1000&before_rowid=3')).json()).messages).toEqual([expected[0], expected[1]]);
  for (let restart = 0; restart < 2; restart++) {
    getDb().close();
    initDb(path);
    const history = await (await request()).json();
    expect(history.messages).toEqual([expected[2], expected[0], expected[1]]);
    for (const message of history.messages) expect(await verifyDeliveredMessage(message)).toEqual(message);
  }
  clock.mockReturnValue(6000);
  deleteExpiredMessages();
  getDb().close();
  initDb(path);
  const later = await send();
  expect((await recover(`after=${initial.recovery_cursor}`)).messages).toEqual([later]);
});

test('cursor authorization, type, and integrity reject forged or cross-conversation recovery', async () => {
  const { recovery_cursor: cursor } = await (await request()).json();
  for (const query of ['', 'after=bad', `after=${cursor}&cursor=${cursor}`, `cursor=${cursor}`,
    `after=${cursor}&after=${cursor}`, `after=${cursor}&limit=200`, `after=${cursor}x`, `after=${cursor.slice(0, -1)}é`]) {
    expect((await request(`/recover?${query}`)).status).toBe(400);
  }
  expect((await request(`/recover?after=${cursor}`, 'invalid')).status).toBe(401);
  expect((await request(`/recover?after=${cursor}`, carol.address)).status).toBe(400);
  expect((await request(`/recover?after=${cursor}`, bob.address, undefined, carol.address)).status).toBe(400);
  const empty = await recover(`after=${cursor}`);
  expect(empty.messages).toEqual([]);
  expect(empty.exhausted).toBe(true);
  expect(empty.recovery_cursor).toBe(cursor);
});

test('recovery limits an identity independently of sending, opening, and state lookup', async () => {
  const { recovery_cursor: cursor } = await (await request()).json();
  for (let n = 0; n < 120; n++) await recover(`after=${cursor}`);
  expect((await request(`/recover?after=${cursor}`)).status).toBe(429);
  const { recovery_cursor: other } = await (await request('', alice.address, undefined, bob.address)).json();
  expect((await request(`/recover?after=${other}`, alice.address, undefined, bob.address)).status).toBe(200);
  const message = await send();
  expect((await request('/state', bob.address, { ids: [message.id] })).status).toBe(200);
  expect((await request('/open', bob.address, { ids: [message.id] })).status).toBe(200);
});

test('recovery caps requests across identities on one IP', async () => {
  for (const address of [alice.address, bob.address]) {
    const { recovery_cursor: cursor } = await (await request('', address)).json();
    for (let n = 0; n < 120; n++) {
      expect((await request(`/recover?after=${cursor}`, address)).status).toBe(200);
    }
  }
  const { recovery_cursor: cursor } = await (await request('', carol.address)).json();
  expect((await request(`/recover?after=${cursor}`, carol.address)).status).toBe(429);
});

test('state lookup bounds IDs, streamed bodies, and request rate independently of opening', async () => {
  const id = `0x${'00'.repeat(16)}`;
  expect((await request('/state', 'invalid', { ids: [id] })).status).toBe(401);
  for (const body of [{ ids: [] }, { ids: [id, id] }, { ids: ['bad'] }, { ids: [id], extra: true }, [],
    { ids: Array.from({ length: 101 }, (_, n) => `0x${n.toString(16).padStart(32, '0')}`) }]) {
    expect((await request('/state', bob.address, body)).status).toBe(400);
  }
  const json = JSON.stringify({ ids: [id] });
  for (const [size, status] of [[8192, 200], [8193, 413]] as const) {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(json));
      controller.enqueue(new TextEncoder().encode(' '.repeat(size - json.length)));
      controller.close();
    } });
    const response = await fetch(new URL(`/api/messages/${alice.address}/state`, server.url), {
      method: 'POST', headers: { Authorization: `Bearer ${bob.address}` }, body,
    });
    expect(response.status).toBe(status);
    await response.body?.cancel();
  }
  for (const limiter of Object.values(limiters)) limiter.reset();
  for (let n = 0; n < 120; n++) expect((await request('/state', bob.address, { ids: [id] })).status).toBe(200);
  expect((await request('/state', bob.address, { ids: [id] })).status).toBe(429);
  expect((await request('/open', bob.address, { ids: [id] })).status).toBe(200);
});
