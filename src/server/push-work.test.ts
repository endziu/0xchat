import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSignedMessageEnvelope } from '../client/lib/message-envelope.ts';
import { createSession, deleteInactivePubkeys, getDb, initDb, registerPubkey } from './db.ts';
import { startPushDispatcher, stopPushDispatcher } from './push.ts';
import { createFetch } from './router.ts';
import * as limiters from './rate-limiters.ts';

function identity(byte: string) {
  const privateKey = `0x${byte.repeat(32)}` as const;
  return {
    privateKey,
    address: privateKeyToAccount(privateKey).address.toLowerCase(),
    publicKey: bytesToHex(secp.getPublicKey(hexToBytes(privateKey), true)),
  };
}

const alice = identity('34');
const bob = identity('45');
const keys = {
  p256dh: Buffer.alloc(65, 1).toString('base64url'),
  auth: Buffer.alloc(16, 2).toString('base64url'),
};
let directory: string;
let server: ReturnType<typeof Bun.serve>;
let clock: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'push-work-'));
  initDb(join(directory, 'chat.db'));
  for (const person of [alice, bob]) {
    registerPubkey(person.address, person.publicKey);
    createSession(person.address, person.address, Date.now() + 60_000);
  }
  for (const limiter of Object.values(limiters)) limiter.reset();
  server = Bun.serve({ port: 0, fetch: createFetch() });
});

afterEach(() => {
  stopPushDispatcher();
  server.stop(true);
  clock?.mockRestore();
  clock = undefined;
  getDb().close();
  for (const limiter of Object.values(limiters)) limiter.reset();
  rmSync(directory, { recursive: true });
});

function request(path: string, token: string, body: unknown) {
  return fetch(new URL(path, server.url), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error('Timed out waiting for push delivery');
}

async function subscribe(endpoint: string) {
  const response = await request('/api/push/subscribe', bob.address, {
    installation_id: crypto.randomUUID(),
    expected_revision: 0,
    subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${endpoint}`, keys },
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function sendMessage(ttl = 300) {
  const envelope = await createSignedMessageEnvelope('wake up', ttl, alice, bob.address, bob.publicKey);
  const response = await request('/api/messages', alice.address, envelope);
  expect(response.status).toBe(201);
}

test('accepted messages durably fan out empty wake-ups with the remaining legacy deadline', async () => {
  for (let index = 0; index < 2; index++) await subscribe(`push-work-${index}`);
  const isolated = await request('/api/push/subscribe', alice.address, {
    installation_id: crypto.randomUUID(),
    expected_revision: 0,
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/alice-isolated', keys },
  });
  expect(isolated.status).toBe(201);

  const deliveries: Array<{ endpoint: string; payload: string | undefined; ttl: number }> = [];
  startPushDispatcher({
    pollIntervalMs: 5,
    send: async (subscription, payload, options) => {
      deliveries.push({ endpoint: subscription.endpoint, payload, ttl: options.TTL });
    },
  });

  await sendMessage();
  await waitFor(() => deliveries.length === 2);

  expect(deliveries.map(delivery => delivery.endpoint).sort()).toEqual([
    'https://fcm.googleapis.com/fcm/send/push-work-0',
    'https://fcm.googleapis.com/fcm/send/push-work-1',
  ]);
  expect(deliveries.every(delivery => delivery.payload === undefined)).toBe(true);
  expect(deliveries.every(delivery => delivery.ttl >= 298 && delivery.ttl <= 300)).toBe(true);
});

test('ambiguous delivery remains durable across a database and dispatcher restart', async () => {
  await subscribe('restart');
  const path = join(directory, 'chat.db');
  const base = Date.now();
  let releaseFirst!: () => void;
  const firstAttempt = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstCalls = 0;
  startPushDispatcher({ pollIntervalMs: 5, sendTimeoutMs: 10, send: async () => {
    firstCalls++;
    await firstAttempt;
  } });

  await sendMessage();
  await waitFor(() => firstCalls === 1);
  stopPushDispatcher();
  getDb().close();
  initDb(path);
  releaseFirst();
  clock = spyOn(Date, 'now').mockReturnValue(base + 2_000);

  let restartedCalls = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => { restartedCalls++; } });
  await waitFor(() => restartedCalls === 1);
  expect(restartedCalls).toBe(1);
});

test('new work arriving in flight survives the observed generation and keeps the latest deadline', async () => {
  await subscribe('coalesced');
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const ttls: number[] = [];
  startPushDispatcher({ pollIntervalMs: 5, send: async (_subscription, _payload, options) => {
    ttls.push(options.TTL);
    if (ttls.length === 1) await blocked;
  } });

  await sendMessage(5);
  await waitFor(() => ttls.length === 1);
  await sendMessage(300);
  release();
  await waitFor(() => ttls.length === 2);

  expect(ttls[0]).toBeLessThanOrEqual(5);
  expect(ttls[1]).toBeGreaterThanOrEqual(298);
});

test('a live identity-wide SSE stream suppresses and discards its observed wake-up', async () => {
  await subscribe('suppressed');
  let deliveries = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => { deliveries++; } });

  const tokenResponse = await fetch(new URL('/api/events/token', server.url), {
    method: 'POST', headers: { Authorization: `Bearer ${bob.address}` },
  });
  const { sse_token: token } = await tokenResponse.json() as { sse_token: string };
  const stream = await fetch(new URL(`/api/events?token=${token}`, server.url));
  const reader = stream.body!.getReader();
  await reader.read();

  await sendMessage();
  await Bun.sleep(25);
  expect(deliveries).toBe(0);
  await reader.cancel();

  await sendMessage();
  await waitFor(() => deliveries === 1);
  expect(deliveries).toBe(1);
});

test('replacement transfers pending work while fencing the old in-flight completion', async () => {
  const installationId = crypto.randomUUID();
  const createdResponse = await request('/api/push/subscribe', bob.address, {
    installation_id: installationId,
    expected_revision: 0,
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/old-endpoint', keys },
  });
  const created = await createdResponse.json() as { slot_id: string; installation_id: string; revision: number };
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const endpoints: string[] = [];
  startPushDispatcher({ pollIntervalMs: 5, send: async subscription => {
    endpoints.push(subscription.endpoint);
    if (endpoints.length === 1) await blocked;
  } });

  await sendMessage();
  await waitFor(() => endpoints.length === 1);
  const replacement = await request('/api/push/reconcile', bob.address, {
    slot_id: created.slot_id,
    installation_id: installationId,
    expected_revision: created.revision,
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/new-endpoint', keys },
  });
  expect(replacement.status).toBe(200);
  release();
  await waitFor(() => endpoints.length === 2);

  expect(endpoints).toEqual([
    'https://fcm.googleapis.com/fcm/send/old-endpoint',
    'https://fcm.googleapis.com/fcm/send/new-endpoint',
  ]);
});

test('slot removal clears pending work and stale completion cannot recreate it', async () => {
  const handle = await subscribe('removed') as { slot_id: string; installation_id: string; revision: number };
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let deliveries = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => {
    deliveries++;
    await blocked;
  } });

  await sendMessage();
  await waitFor(() => deliveries === 1);
  const removed = await request('/api/push/unsubscribe', bob.address, {
    slot_id: handle.slot_id,
    installation_id: handle.installation_id,
    expected_revision: handle.revision,
  });
  expect(removed.status).toBe(200);
  release();
  await Bun.sleep(20);
  await sendMessage();
  await Bun.sleep(20);
  expect(deliveries).toBe(1);
});

test('registration pruning clears durable work before an ambiguous attempt can resume', async () => {
  await subscribe('pruned');
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let initialCalls = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => {
    initialCalls++;
    await blocked;
  } });
  await sendMessage();
  await waitFor(() => initialCalls === 1);

  stopPushDispatcher();
  deleteInactivePubkeys(Date.now() + 1);
  let restartedCalls = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => { restartedCalls++; } });
  await Bun.sleep(20);
  release();
  expect(restartedCalls).toBe(0);
});

test('restart preserves future due time and provider not-before without extending the deadline', async () => {
  await subscribe('not-before');
  const path = join(directory, 'chat.db');
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  await sendMessage(300);
  getDb().query('UPDATE push_work SET due_at = ?, provider_not_before = ?').run(base + 1_000, base + 2_000);
  getDb().close();
  initDb(path);

  let deliveries = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => { deliveries++; } });
  clock.mockReturnValue(base + 1_500);
  await Bun.sleep(15);
  expect(deliveries).toBe(0);
  clock.mockReturnValue(base + 2_000);
  await waitFor(() => deliveries === 1);
  expect(deliveries).toBe(1);
});

test('dormant opening policy still uses the signed legacy lifetime for push scheduling', async () => {
  await subscribe('legacy-deadline');
  server.stop(true);
  server = Bun.serve({ port: 0, fetch: createFetch({ testDeliveryPolicy: 'recipient-opening' }) });
  const ttls: number[] = [];
  startPushDispatcher({ pollIntervalMs: 5, send: async (_subscription, _payload, options) => {
    ttls.push(options.TTL);
  } });

  await sendMessage(5);
  await waitFor(() => ttls.length === 1);
  expect(ttls[0]).toBeGreaterThanOrEqual(3);
  expect(ttls[0]).toBeLessThanOrEqual(5);
});

test('work with less than one second remaining is discarded instead of sent past its deadline', async () => {
  await subscribe('expired');
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  await sendMessage(5);
  clock.mockReturnValue(base + 4_001);

  let deliveries = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => { deliveries++; } });
  await Bun.sleep(15);
  expect(deliveries).toBe(0);
  await sendMessage(300);
  await waitFor(() => deliveries === 1);
  expect(deliveries).toBe(1);
});

test('delivery concurrency and network waiting are bounded', async () => {
  for (let index = 0; index < 5; index++) await subscribe(`bounded-${index}`);
  let active = 0;
  let maximumActive = 0;
  let deliveries = 0;
  startPushDispatcher({ concurrency: 2, pollIntervalMs: 5, sendTimeoutMs: 100, send: async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await Bun.sleep(10);
    active--;
    deliveries++;
  } });

  await sendMessage();
  await waitFor(() => deliveries === 5);
  expect(maximumActive).toBe(2);

  stopPushDispatcher();
  let attempts = 0;
  startPushDispatcher({ pollIntervalMs: 5, sendTimeoutMs: 10, send: async () => {
    attempts++;
    if (attempts === 1) await new Promise<void>(() => {});
  } });
  await sendMessage();
  await waitFor(() => attempts === 5);
  await Bun.sleep(20);
  await sendMessage();
  await waitFor(() => attempts === 9);
  await Bun.sleep(20);
  expect(attempts).toBe(9);
});
