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
import { sendPushNotification } from './push-provider.ts';
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

function extendSession(address: string, expiresAt: number) {
  getDb().query('UPDATE sessions SET expires_at = ? WHERE address = ?').run(expiresAt, address.toLowerCase());
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
  server.stop(true);
  getDb().close();
  initDb(path);
  server = Bun.serve({ port: 0, fetch: createFetch() });
  releaseFirst();
  clock = spyOn(Date, 'now').mockReturnValue(base + 2_000);

  let restartedCalls = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => { restartedCalls++; } });
  await waitFor(() => restartedCalls === 1);
  expect(restartedCalls).toBe(1);
});

test.each(['SSE', 'subsecond'])('restart discards expired-claim work under %s suppression without blocking the event loop', async reason => {
  await subscribe('restart-suppressed');
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  let started = false;
  let release!: () => void;
  startPushDispatcher({ sendTimeoutMs: 10, send: () => {
    started = true;
    return new Promise<void>(resolve => { release = resolve; });
  } });
  await sendMessage(5);
  await waitFor(() => started);
  stopPushDispatcher();
  release();
  await Bun.sleep(5);

  // A separate process gives the regression a watchdog even if dispatch starves timers.
  const proc = Bun.spawn([process.execPath, '--eval', `
    import { initDb, getDb } from './db.ts';
    import { startPushDispatcher, stopPushDispatcher } from './push.ts';
    import { addClient, removeClient } from './sse.ts';
    initDb(${JSON.stringify(join(directory, 'chat.db'))});
    Date.now = () => ${base + (reason === 'SSE' ? 2_000 : 4_001)};
    let controller;
    if (${reason === 'SSE'}) new ReadableStream({ start(ctrl) {
      controller = ctrl;
      addClient(${JSON.stringify(bob.address)}, ctrl);
    } });
    let deliveries = 0;
    startPushDispatcher({ pollIntervalMs: 5, send: async () => { deliveries++; } });
    await Bun.sleep(30);
    if (controller) removeClient(${JSON.stringify(bob.address)}, controller);
    Date.now = () => ${base + 2_000};
    await Bun.sleep(30);
    stopPushDispatcher();
    getDb().close();
    console.log(JSON.stringify({ deliveries }));
  `], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' });
  const watchdog = setTimeout(() => proc.kill(), 2_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({ deliveries: 0 });
  } finally {
    clearTimeout(watchdog);
    proc.kill();
  }
});

test('absolute cancellation frees every occupied delivery slot', async () => {
  for (let index = 0; index < 5; index++) await subscribe(`cancel-${index}`);
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  let attempts = 0;
  let active = 0;
  let cancelled = 0;
  startPushDispatcher({ pollIntervalMs: 5, sendTimeoutMs: 20, send: async (_sub, _payload, options) => {
    attempts++;
    active++;
    try {
      if (attempts <= 4) await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          cancelled++;
          reject(options.signal.reason);
        }, { once: true });
      });
    } finally {
      active--;
    }
  } });
  await sendMessage(3600);
  await waitFor(() => attempts === 5 && active === 0);
  expect(cancelled).toBe(4);
  // The aborted attempts are temporary failures: the new message coalesces into
  // the retained work but must not force an early attempt on the backoff.
  await sendMessage(3600);
  await Bun.sleep(30);
  expect(attempts).toBe(6);
  clock.mockReturnValue(base + 60_000);
  await waitFor(() => attempts === 10);
  expect(attempts).toBe(10);
});

test('the real outbound transport cancels stalled requests and continues dispatching', async () => {
  for (let index = 0; index < 5; index++) await subscribe(`transport-${index}`);
  let requests = 0;
  let cancelled = 0;
  const provider = Bun.serve({ port: 0, async fetch(request) {
    requests++;
    if (requests <= 4) return new Promise<Response>(resolve => {
      request.signal.addEventListener('abort', () => {
        cancelled++;
        resolve(new Response(null, { status: 503 }));
      }, { once: true });
    });
    return new Response(null, { status: 201 });
  } });
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  try {
    startPushDispatcher({ pollIntervalMs: 5, sendTimeoutMs: 50, send: (subscription, payload, options) =>
      sendPushNotification({ ...subscription, endpoint: provider.url.href }, payload, options),
    });
    await sendMessage(3600);
    await waitFor(() => requests === 5 && cancelled === 4);
    // A stalled, aborted transport is a temporary failure: the new message
    // must not force an early attempt on the backed-off endpoint.
    await sendMessage(3600);
    await Bun.sleep(30);
    expect(requests).toBe(6);
    clock.mockReturnValue(base + 60_000);
    await waitFor(() => requests === 10);
    expect(requests).toBe(10);
  } finally {
    stopPushDispatcher();
    provider.stop(true);
  }
});

test('a temporary provider failure retries after one minute without another message', async () => {
  await subscribe('retry-503');
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  const attempts: number[] = [];
  let failures = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => {
    attempts.push(Date.now());
    if (failures++ === 0) throw Object.assign(new Error('provider unavailable'), { statusCode: 503 });
  } });

  await sendMessage(300);
  await waitFor(() => attempts.length === 1);
  clock.mockReturnValue(base + 59_999);
  await Bun.sleep(15);
  expect(attempts.length).toBe(1);
  clock.mockReturnValue(base + 60_000);
  await waitFor(() => attempts.length === 2);
  expect(attempts[1] - attempts[0]).toBe(60_000);
});

test('temporary failures double the retry delay after each attempt up to a one-hour cap', async () => {
  await subscribe('backoff-cap');
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  const attempts: number[] = [];
  startPushDispatcher({ pollIntervalMs: 5, send: async () => {
    attempts.push(Date.now());
    throw Object.assign(new Error('provider still down'), { statusCode: 500 });
  } });

  const expectedGaps = [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000];
  await sendMessage(86400);
  let due = 0;
  for (let index = 0; index < expectedGaps.length; index++) {
    await waitFor(() => attempts.length === index + 1);
    const nextDue = due + expectedGaps[index];
    // The retry must not fire before its exact due time.
    clock.mockReturnValue(base + nextDue - 1);
    await Bun.sleep(15);
    expect(attempts.length).toBe(index + 1);
    due = nextDue;
    clock.mockReturnValue(base + due);
  }
  await waitFor(() => attempts.length === 8);
  expect(attempts.slice(1).map((attempt, index) => attempt - attempts[index])).toEqual(expectedGaps);
});

test('a longer valid provider-requested delay wins and persists across a restart', async () => {
  await subscribe('retry-after');
  const path = join(directory, 'chat.db');
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  let attempts = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => {
    if (attempts++ === 0) throw Object.assign(new Error('rate limited'), { statusCode: 429, retryAfterMs: 180_000 });
  } });

  await sendMessage(3600);
  await waitFor(() => attempts === 1);
  server.stop(true);
  getDb().close();
  initDb(path);
  server = Bun.serve({ port: 0, fetch: createFetch() });
  startPushDispatcher({ pollIntervalMs: 5, send: async () => { attempts++; } });
  clock.mockReturnValue(base + 60_000);
  await Bun.sleep(15);
  clock.mockReturnValue(base + 179_999);
  await Bun.sleep(15);
  expect(attempts).toBe(1);
  clock.mockReturnValue(base + 180_000);
  await waitFor(() => attempts === 2);
  expect(attempts).toBe(2);
});

test('a shorter provider delay does not beat the backoff and coalescing keeps the schedule', async () => {
  await subscribe('short-delay');
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  const attempts: Array<{ at: number; ttl: number }> = [];
  let failures = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async (_s, _p, options) => {
    attempts.push({ at: Date.now(), ttl: options.TTL });
    if (failures++ === 0) throw Object.assign(new Error('rate limited'), { statusCode: 429, retryAfterMs: 5_000 });
  } });

  await sendMessage(300);
  await waitFor(() => attempts.length === 1);
  clock.mockReturnValue(base + 5_000);
  await Bun.sleep(15);
  expect(attempts.length).toBe(1);
  // A new message coalesces into the backed-off work: it extends the deadline
  // but must not reset the backoff or force an early attempt.
  await sendMessage(300);
  clock.mockReturnValue(base + 59_999);
  await Bun.sleep(15);
  expect(attempts.length).toBe(1);
  clock.mockReturnValue(base + 60_000);
  await waitFor(() => attempts.length === 2);
  // Latest deadline: the second message (accepted at base+5s, ttl 300s) wins.
  expect(attempts[1].ttl).toBeGreaterThanOrEqual(243);
  expect(attempts[1].ttl).toBeLessThanOrEqual(245);
});

test('a successful older attempt does not inflate the retained newer work backoff', async () => {
  await subscribe('success-inflate');
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const attempts: number[] = [];
  startPushDispatcher({ pollIntervalMs: 5, send: async () => {
    attempts.push(Date.now());
    if (attempts.length === 1) await blocked;
    if (attempts.length === 2) throw Object.assign(new Error('provider down'), { statusCode: 503 });
  } });

  await sendMessage(300);
  await waitFor(() => attempts.length === 1);
  await sendMessage(86400);
  release();
  await Bun.sleep(5);
  // The retained newer work is attempted immediately and fails temporarily.
  await waitFor(() => attempts.length === 2);
  // Its first temporary failure waits one minute, not the doubled delay of a
  // second consecutive failure.
  clock.mockReturnValue(base + 59_999);
  await Bun.sleep(15);
  expect(attempts.length).toBe(2);
  clock.mockReturnValue(base + 60_000);
  await waitFor(() => attempts.length === 3);
  expect(attempts.length).toBe(3);
});

test('a failure applies its backoff to newer work that coalesced while in flight', async () => {
  await subscribe('inflight-backoff');
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const attempts: Array<{ at: number; ttl: number }> = [];
  startPushDispatcher({ pollIntervalMs: 5, send: async (_s, _p, options) => {
    attempts.push({ at: Date.now(), ttl: options.TTL });
    if (attempts.length === 1) {
      await blocked;
      throw Object.assign(new Error('provider down'), { statusCode: 503 });
    }
  } });

  await sendMessage(300);
  await waitFor(() => attempts.length === 1);
  await sendMessage(86400);
  release();
  // Let the failure record its backoff before the test moves the clock.
  await Bun.sleep(5);
  // The retained newer work waits out the first failure's one-minute backoff
  // before any second attempt, then uses the extended deadline.
  clock.mockReturnValue(base + 59_999);
  await Bun.sleep(15);
  expect(attempts.length).toBe(1);
  clock.mockReturnValue(base + 60_000);
  await waitFor(() => attempts.length === 2);
  expect(attempts[1].ttl).toBeGreaterThanOrEqual(86_338);
  expect(attempts[1].ttl).toBeLessThanOrEqual(86_340);
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

test('suppression discards a waiting retry and never schedules catch-up after disconnect', async () => {
  await subscribe('suppressed-retry');
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  let deliveries = 0;
  let failures = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => {
    if (failures++ === 0) throw Object.assign(new Error('provider down'), { statusCode: 503 });
    deliveries++;
  } });

  await sendMessage(3600);
  await waitFor(() => failures === 1);

  const tokenResponse = await fetch(new URL('/api/events/token', server.url), {
    method: 'POST', headers: { Authorization: `Bearer ${bob.address}` },
  });
  const { sse_token: token } = await tokenResponse.json() as { sse_token: string };
  const stream = await fetch(new URL(`/api/events?token=${token}`, server.url));
  const reader = stream.body!.getReader();
  await reader.read();

  clock.mockReturnValue(base + 60_000);
  await Bun.sleep(25);
  expect(deliveries).toBe(0);
  await reader.cancel();
  await Bun.sleep(25);
  expect(deliveries).toBe(0);
  extendSession(alice.address, base + 600_000);
  await sendMessage(3600);
  await waitFor(() => deliveries === 1);
  expect(deliveries).toBe(1);
});

const nonTemporaryFailures = [
  { name: 'configuration error', fail: () => new Error('VAPID private key not configured') },
  { name: 'status 400', fail: () => Object.assign(new Error('rejected'), { statusCode: 400 }) },
  { name: 'status 401', fail: () => Object.assign(new Error('rejected'), { statusCode: 401 }) },
  { name: 'status 403', fail: () => Object.assign(new Error('rejected'), { statusCode: 403 }) },
];

test.each(nonTemporaryFailures)('$name is not temporary and never enters the retry schedule', async scenario => {
  await subscribe(`no-retry-${scenario.name.replace(/\s/g, '-')}`);
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  const attempts: number[] = [];
  startPushDispatcher({ pollIntervalMs: 5, send: async () => {
    attempts.push(Date.now());
    if (attempts.length === 1) throw scenario.fail();
  } });

  await sendMessage(3600);
  await waitFor(() => attempts.length === 1);
  // The non-temporary failure completes the generation; a new message starts
  // fresh immediately instead of inheriting a temporary backoff.
  await sendMessage(3600);
  await waitFor(() => attempts.length === 2);
  expect(attempts[1] - attempts[0]).toBe(0);
  clock.mockReturnValue(base + 60_000);
  await Bun.sleep(25);
  expect(attempts.length).toBe(2);
});

test.each([404, 410])('confirmed-dead status %s stops retrying, stays repairable, and recovers on replacement', async status => {
  const installationId = crypto.randomUUID();
  const created = await request('/api/push/subscribe', bob.address, {
    installation_id: installationId,
    expected_revision: 0,
    subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/dead-endpoint-${status}`, keys },
  });
  expect(created.status).toBe(201);
  const handle = await created.json() as { slot_id: string; installation_id: string; revision: number };
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  let attempts = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => {
    attempts++;
    throw Object.assign(new Error('gone'), { statusCode: status });
  } });

  await sendMessage(3600);
  await waitFor(() => attempts === 1);
  clock.mockReturnValue(base + 60_000);
  await Bun.sleep(25);
  expect(attempts).toBe(1);

  extendSession(alice.address, base + 600_000);
  extendSession(bob.address, base + 600_000);
  const list = await (await fetch(new URL('/api/push/subscriptions', server.url), {
    headers: { Authorization: `Bearer ${bob.address}` },
  })).json() as { slots: Array<{ slot_id: string; state: string }> };
  // The confirmed-dead slot retains its owned reservation without endpoint or
  // key material; only a repaired endpoint becomes deliverable.
  expect(list.slots).toEqual([expect.objectContaining({ slot_id: handle.slot_id, state: 'repair_needed' })]);

  const replacement = await request('/api/push/reconcile', bob.address, {
    slot_id: handle.slot_id,
    installation_id: installationId,
    expected_revision: handle.revision + 1,
    subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/repaired-endpoint-${status}`, keys },
  });
  expect(replacement.status).toBe(200);
  startPushDispatcher({ pollIntervalMs: 5, send: async () => { attempts++; } });
  await sendMessage(3600);
  await waitFor(() => attempts === 2);
  expect(attempts).toBe(2);
});

test('an unfocused browser stream stays live while push delivery follows attention', async () => {
  await subscribe('background-live');
  let deliveries = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => { deliveries++; } });

  const tokenResponse = await fetch(new URL('/api/events/token', server.url), {
    method: 'POST', headers: { Authorization: `Bearer ${bob.address}` },
  });
  const { sse_token: token } = await tokenResponse.json() as { sse_token: string };
  const stream = await fetch(new URL(`/api/events?token=${token}&attentive=false`, server.url));
  const reader = stream.body!.getReader();
  await reader.read();

  await sendMessage();
  await waitFor(() => deliveries === 1);
  expect((await request('/api/events/attention', bob.address,
    { stream: token, attentive: true, sequence: 1 })).status).toBe(204);
  await sendMessage();
  await Bun.sleep(25);
  expect(deliveries).toBe(1);

  expect((await request('/api/events/attention', bob.address,
    { stream: token, attentive: false, sequence: 2 })).status).toBe(204);
  await sendMessage();
  await waitFor(() => deliveries === 2);
  await reader.cancel();
});

test('temporary failure backoff is isolated per endpoint', async () => {
  await subscribe('iso-failing');
  await subscribe('iso-healthy');
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  const endpoints: string[] = [];
  startPushDispatcher({ pollIntervalMs: 5, send: async subscription => {
    endpoints.push(subscription.endpoint);
    if (subscription.endpoint.includes('iso-failing')) throw Object.assign(new Error('down'), { statusCode: 502 });
  } });

  await sendMessage(3600);
  await waitFor(() => endpoints.length === 2);
  clock.mockReturnValue(base + 60_000);
  await Bun.sleep(25);
  expect(endpoints.filter(endpoint => endpoint.includes('iso-failing')).length).toBe(2);
  expect(endpoints.filter(endpoint => endpoint.includes('iso-healthy')).length).toBe(1);
});

test('retry work that expires while waiting is discarded and later work still delivers', async () => {
  await subscribe('expired-retry');
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  let attempts = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('down'), { statusCode: 503 });
  } });

  await sendMessage(30);
  await waitFor(() => attempts === 1);
  clock.mockReturnValue(base + 60_000);
  await Bun.sleep(25);
  expect(attempts).toBe(1);
  extendSession(alice.address, base + 600_000);
  await sendMessage(3600);
  await waitFor(() => attempts === 2);
  expect(attempts).toBe(2);
});

test('a late timeout on replaced ownership does not back off the replacement slot', async () => {
  const installationId = crypto.randomUUID();
  const created = await request('/api/push/subscribe', bob.address, {
    installation_id: installationId,
    expected_revision: 0,
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/replace-old', keys },
  });
  expect(created.status).toBe(201);
  const handle = await created.json() as { slot_id: string; installation_id: string; revision: number };
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const endpoints: string[] = [];
  startPushDispatcher({ pollIntervalMs: 5, sendTimeoutMs: 10, send: async subscription => {
    endpoints.push(subscription.endpoint);
    if (endpoints.length === 1) {
      await blocked;
      throw Object.assign(new Error('late failure'), { statusCode: 503 });
    }
  } });

  await sendMessage(3600);
  await waitFor(() => endpoints.length === 1);
  const replacement = await request('/api/push/reconcile', bob.address, {
    slot_id: handle.slot_id,
    installation_id: installationId,
    expected_revision: handle.revision,
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/replace-new', keys },
  });
  expect(replacement.status).toBe(200);
  // The old transport finally fails late. It must not schedule a backoff for
  // the transferred replacement work, which stays due at its original time.
  release();
  clock.mockReturnValue(base + 12_000);
  await waitFor(() => endpoints.length === 2 && endpoints[1].includes('replace-new'));
  await Bun.sleep(30);
  clock.mockReturnValue(base + 59_999);
  await Bun.sleep(30);
  expect(endpoints.length).toBe(2);
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

test('a late failure on a removed slot cannot recreate its work', async () => {
  const handle = await subscribe('late-removed');
  const base = Date.now();
  clock = spyOn(Date, 'now').mockReturnValue(base);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  startPushDispatcher({ pollIntervalMs: 5, send: async () => {
    attempts++;
    await blocked;
    throw Object.assign(new Error('late failure'), { statusCode: 503 });
  } });

  await sendMessage(3600);
  await waitFor(() => attempts === 1);
  const removed = await request('/api/push/unsubscribe', bob.address, {
    slot_id: handle.slot_id,
    installation_id: handle.installation_id,
    expected_revision: handle.revision,
  });
  expect(removed.status).toBe(200);
  release();
  await Bun.sleep(30);
  await sendMessage(3600);
  await Bun.sleep(30);
  expect(attempts).toBe(1);
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
  server.stop(true);
  getDb().close();
  initDb(path);
  server = Bun.serve({ port: 0, fetch: createFetch() });

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
