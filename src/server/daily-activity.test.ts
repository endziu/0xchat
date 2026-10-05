import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { requireAddress } from '../shared/address.ts';
import { MESSAGE_ENVELOPE_VERSION, type MessageEnvelope } from '../shared/message-envelope.ts';
import { createMessage, createSession, getDb, getMessageStates, initDb, openMessages, pruneDailyActivity, recordDailyActivity, registerPubkey } from './db.ts';
import { readDailyActivityTotals } from './dau-command.ts';
import { handleGetSSEToken, handleSSE, handleSSEAttention } from './routes/events.ts';
import { sseTokenLimiter } from './rate-limiters.ts';
import { noOpSchedule } from './rate-limit.test-utils.ts';
import { publish } from './sse.ts';
import type { Context } from './http.ts';

const sender = requireAddress(`0x${'a'.repeat(40)}`);
const recipient = requireAddress(`0x${'b'.repeat(40)}`);
const day = Date.parse('2026-10-05T23:59:59Z');
let now = day;
let clock: ReturnType<typeof spyOn<typeof Date, 'now'>>;

function totals() {
  return getDb().query('SELECT day, identities FROM daily_activity_totals ORDER BY day').all();
}

function envelope(id = 'test-message'): MessageEnvelope {
  return { version: MESSAGE_ENVELOPE_VERSION, id, sender, recipient, ttl: 60,
    ct_recipient: 'test', ephemeral_pub_recipient: 'test', iv_recipient: 'test',
    ct_sender: 'test', ephemeral_pub_sender: 'test', iv_sender: 'test', signature: 'test' };
}

beforeEach(() => {
  now = day;
  clock = spyOn(Date, 'now').mockImplementation(() => now);
  initDb(':memory:');
  sseTokenLimiter.setSchedule(noOpSchedule);
  sseTokenLimiter.reset();
});

afterEach(() => {
  getDb().close();
  clock.mockRestore();
  sseTokenLimiter.reset();
});

test('deduplicates authenticated identities across sessions, with only keyed hashes stored', () => {
  registerPubkey(sender, 'test');
  createSession('tab-one', sender, now + 60_000);
  createSession('device-two', sender, now + 60_000);
  expect(totals()).toEqual([]);
  recordDailyActivity(sender);
  recordDailyActivity(sender);
  recordDailyActivity(requireAddress(sender.toUpperCase().replace('0X', '0x')));
  recordDailyActivity(recipient);
  expect(totals()).toEqual([{ day: '2026-10-05', identities: 2 }]);
  const rows = getDb().query('SELECT * FROM daily_activity_seen').all();
  expect(rows).toHaveLength(2);
  expect(JSON.stringify(rows)).not.toContain(sender.slice(2));
});

test('UTC rollover deletes old hashes and keys but retains historical totals', () => {
  recordDailyActivity(sender);
  const first = getDb().query('SELECT identity_hash FROM daily_activity_seen').get();
  now += 1000;
  recordDailyActivity(sender);
  expect(totals()).toEqual([
    { day: '2026-10-05', identities: 1 }, { day: '2026-10-06', identities: 1 },
  ]);
  expect(getDb().query('SELECT identity_hash FROM daily_activity_seen').get()).not.toEqual(first);
  expect(getDb().query('SELECT day FROM daily_activity_keys').all()).toEqual([{ day: '2026-10-06' }]);
  now += 86_400_000;
  pruneDailyActivity();
  expect(getDb().query('SELECT * FROM daily_activity_seen').all()).toEqual([]);
  expect(getDb().query('SELECT * FROM daily_activity_keys').all()).toEqual([]);
  expect(totals()).toHaveLength(2);
});

test('recording uses one captured UTC day even if the clock crosses midnight', () => {
  recordDailyActivity(sender);
  clock.mockReturnValueOnce(day).mockReturnValue(day + 1000);
  recordDailyActivity(sender);
  expect(totals()).toEqual([{ day: '2026-10-05', identities: 1 }]);
  expect(getDb().query('SELECT day FROM daily_activity_keys').all()).toEqual([{ day: '2026-10-05' }]);
});

test('persistent deduplication survives restart and the command reads only aggregates', () => {
  const path = `/tmp/0xchat-dau-${crypto.randomUUID()}.db`;
  getDb().close();
  initDb(path);
  try {
    recordDailyActivity(sender);
    getDb().close();
    initDb(path);
    recordDailyActivity(sender);
    expect(readDailyActivityTotals(path)).toEqual([{ day: '2026-10-05', identities: 1 }]);
    now += 1000;
    getDb().close();
    initDb(path);
    expect(getDb().query('SELECT * FROM daily_activity_keys').all()).toEqual([]);
    expect(readDailyActivityTotals(path)).toEqual([{ day: '2026-10-05', identities: 1 }]);
  } finally {
    getDb().close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(path + suffix); } catch { /* SQLite may have removed sidecars. */ }
    }
    initDb(':memory:');
  }
});

test('sending counts only the sender; reading state and unavailable openings do not count recipients', () => {
  createMessage(envelope());
  expect(totals()).toEqual([{ day: '2026-10-05', identities: 1 }]);
  getMessageStates(recipient, sender, ['test-message']);
  openMessages(recipient, sender, ['missing']);
  expect(totals()).toEqual([{ day: '2026-10-05', identities: 1 }]);
  openMessages(recipient, sender, ['test-message']);
  openMessages(recipient, sender, ['test-message']);
  expect(totals()).toEqual([{ day: '2026-10-05', identities: 2 }]);
  now += 1000;
  expect(createMessage(envelope())).toBeNull();
  expect(totals()).toHaveLength(1);
});

function context(path: string, body?: unknown, token = 'activity-session'): Context {
  const req = new Request(`https://chat.example${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-0xChat-Delivery-Capability': 'recipient-opening-v1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { req, url: new URL(req.url), path, method: req.method, ip: 'daily-activity-test' };
}

async function connect(attentive: string) {
  const minted = await handleGetSSEToken(context('/api/events/token', {}));
  const { sse_token: stream } = await minted.json();
  const response = await handleSSE(context(`/api/events?token=${stream}${attentive}`));
  expect(response.status).toBe(200);
  return { stream: String(stream), reader: response.body!.getReader() };
}

test('only explicit foreground attention counts, not auth, connections, receipt or stale reports', async () => {
  createSession('activity-session', recipient, now + 172_800_000);
  const legacy = await connect('');
  const hidden = await connect('&attentive=false');
  try {
    publish(recipient, { type: 'user:disconnected', data: { address: sender } });
    expect(totals()).toEqual([]);
    const report = (attentive: boolean, sequence: number, token?: string) =>
      handleSSEAttention(context('/api/events/attention', { stream: hidden.stream, attentive, sequence }, token));
    expect((await report(true, 1, 'invalid')).status).toBe(401);
    expect(totals()).toEqual([]);
    expect((await report(true, 1)).status).toBe(204);
    expect((await report(false, 2)).status).toBe(204);
    now += 1000;
    expect((await report(true, 1)).status).toBe(204);
    expect(totals()).toEqual([{ day: '2026-10-05', identities: 1 }]);
    expect((await report(true, 3)).status).toBe(204);
    expect(totals()).toHaveLength(2);
  } finally {
    await legacy.reader.cancel();
    await hidden.reader.cancel();
  }
});

test('foreground connection counts immediately and deduplicates across streams', async () => {
  createSession('activity-session', recipient, now + 60_000);
  const first = await connect('&attentive=true');
  const second = await connect('&attentive=true');
  try {
    expect(totals()).toEqual([{ day: '2026-10-05', identities: 1 }]);
  } finally {
    await first.reader.cancel();
    await second.reader.cancel();
  }
});
