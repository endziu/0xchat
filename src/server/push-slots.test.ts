import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, deleteExpiredSessions, deleteInactivePubkeys, getDb, initDb, registerPubkey } from './db.ts';
import { createFetch } from './router.ts';
import * as limiters from './rate-limiters.ts';
import { Database } from 'bun:sqlite';
import type { PushSlotHandle } from '../shared/push-slot.ts';

const alice = `0x${'a'.repeat(40)}`;
const bob = `0x${'b'.repeat(40)}`;
const keys = { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') };
let directory: string;
let server: ReturnType<typeof Bun.serve>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'push-slots-'));
  initDb(join(directory, 'chat.db'));
  for (const address of [alice, bob]) {
    registerPubkey(address, 'test-key');
    createSession(address, address.toUpperCase(), Date.now() + 60_000);
  }
  for (const limiter of Object.values(limiters)) limiter.reset();
  server = Bun.serve({ port: 0, fetch: createFetch() });
});
afterEach(() => {
  server.stop(true);
  getDb().close();
  for (const limiter of Object.values(limiters)) limiter.reset();
  rmSync(directory, { recursive: true });
});
function request(path: string, body?: unknown, token = alice) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const url = new URL(`/api/push/${path}`, server.url);
  return body === undefined ? fetch(url, { headers })
    : fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}
function enable(installation: string = crypto.randomUUID(), endpoint: string = crypto.randomUUID()) {
  return { installation_id: installation, expected_revision: 0,
    subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${endpoint}`, keys } };
}

function condition(handle: PushSlotHandle) {
  return { slot_id: handle.slot_id, installation_id: handle.installation_id, expected_revision: handle.revision };
}

test('durable removal wins over stale reconciliation, allows only fresh explicit enabling, and frees the endpoint', async () => {
  const body = enable();
  const handle = await (await request('subscribe', body)).json();
  const stale = { ...body, ...condition(handle) };
  expect((await request('reconcile', stale)).status).toBe(200);
  const foreign = await request('unsubscribe', condition(handle), bob);
  expect(foreign.status).toBe(409);
  const removed = await (await request('unsubscribe', condition(handle))).json();
  expect(removed).toEqual({ ...handle, revision: 2 });
  expect(await (await request('unsubscribe', condition(handle))).json()).toEqual(removed);
  getDb().close();
  initDb(join(directory, 'chat.db'));
  expect((await (await request('reconcile', stale)).json()).code).toBe('revoked');
  expect((await (await request('subscribe', stale)).json()).code).toBe('revision_conflict');
  expect((await (await request('subscribe', body)).json()).code).toBe('revoked');
  const listed = await (await request('subscriptions')).json();
  expect(listed).toEqual({ slots: [], revocations: [removed] });
  // The endpoint is no longer reserved; a different authenticated identity may now bind it.
  expect((await request('subscribe', { ...body, installation_id: crypto.randomUUID() }, bob)).status).toBe(201);
  limiters.pushMutationLimiter.reset();
  const fresh = await request('subscribe', { ...enable(body.installation_id), ...condition(removed) });
  expect(fresh.status).toBe(201);
  expect(await fresh.json()).toEqual({ ...handle, revision: 3 });
  expect((await request('unsubscribe', condition(handle))).status).toBe(409);
});

test('unknown reconciliation never creates a slot', async () => {
  const result = await request('reconcile', { ...enable(), slot_id: crypto.randomUUID(), expected_revision: 1 });
  expect(result.status).toBe(409);
  expect((await result.json()).code).toBe('repair_needed');
  expect((await (await request('subscriptions')).json()).slots).toEqual([]);
});

test('registration pruning clears slots and revocations while session expiry and revocation preserve them', async () => {
  const first = await (await request('subscribe', enable())).json();
  await request('unsubscribe', condition(first));
  await request('subscribe', enable());
  const before = await (await request('subscriptions')).json();
  createSession('expired', alice, 1);
  deleteExpiredSessions();
  expect(await (await request('subscriptions')).json()).toEqual(before);
  await fetch(new URL('/api/session', server.url), { method: 'DELETE', headers: { Authorization: `Bearer ${alice}` } });
  createSession(alice, alice, Date.now() + 60_000);
  expect(await (await request('subscriptions')).json()).toEqual(before);
  deleteInactivePubkeys(Date.now() + 1);
  expect(await (await request('subscriptions')).json()).toEqual({ slots: [], revocations: [] });
  expect((await (await request('subscribe', enable())).json()).code).toBe('registration_required');
});

test('explicit registration deletion clears slots and revocations', async () => {
  const first = await (await request('subscribe', enable())).json();
  await request('unsubscribe', condition(first));
  await request('subscribe', enable());
  const response = await fetch(new URL(`/api/addresses/${alice}`, server.url), {
    method: 'DELETE', headers: { Authorization: `Bearer ${alice}` },
  });
  expect(response.status).toBe(200);
  registerPubkey(alice, 'test-key');
  createSession(alice, alice, Date.now() + 60_000);
  expect(await (await request('subscriptions')).json()).toEqual({ slots: [], revocations: [] });
});

function migrateLegacy(rows: Array<{ address: string; endpoint: string }>, registered = [alice, bob]) {
  getDb().close();
  const path = join(directory, 'legacy.db');
  const old = new Database(path);
  old.run('CREATE TABLE pubkeys (address TEXT PRIMARY KEY, pubkey TEXT NOT NULL, last_active_at INTEGER NOT NULL)');
  for (const address of registered) old.query('INSERT INTO pubkeys VALUES (?, ?, ?)').run(address, 'test-key', Date.now());
  old.run(`CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, address TEXT NOT NULL,
    p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  for (const row of rows) old.query('INSERT INTO push_subscriptions VALUES (?, ?, ?, ?, ?)')
    .run(row.endpoint, row.address, keys.p256dh, keys.auth, 1234);
  old.close();
  initDb(path);
  for (const address of registered) createSession(address, address, Date.now() + 60_000);
  return path;
}

// A separate Bun process keeps VAPID configuration and the fake outbound provider
// isolated from other tests. Exercise production delivery against the migrated DB.
async function deliveredSubscriptions(path: string, addresses = [alice, bob]): Promise<Array<{ endpoint: string; keys: typeof keys }>> {
  const proc = Bun.spawn([process.execPath, '--eval', `
    import webpush from 'web-push';
    const vapid = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
    const sent = [];
    webpush.sendNotification = async subscription => {
      sent.push(subscription);
      return { statusCode: 201, body: '', headers: {} };
    };
    const { initDb, getDb } = await import('./db.ts');
    const { pushNotify } = await import('./push.ts');
    initDb(${JSON.stringify(path)});
    for (const address of ${JSON.stringify(addresses)}) await pushNotify(address, 60);
    getDb().close();
    console.log(JSON.stringify(sent));
  `], { cwd: import.meta.dir, env: { ...process.env, DEBUG: '0' }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  return JSON.parse(stdout);
}

test('legacy over-cap migration is repeatable, preserves bindings, and adoption requires the owner plus endpoint', async () => {
  const path = migrateLegacy(Array.from({ length: 6 }, (_, i) => ({
    address: alice.toUpperCase(), endpoint: enable('unused', `legacy-${i}`).subscription.endpoint,
  })));
  const listed = await (await request('subscriptions')).json();
  expect(listed.slots).toHaveLength(6);
  expect(listed.slots.every((slot: { created_at: number }) => slot.created_at === 1234)).toBe(true);
  getDb().close();
  initDb(path);
  expect(await (await request('subscriptions')).json()).toEqual(listed);
  const claim = enable(crypto.randomUUID(), 'legacy-0');
  expect((await (await request('subscribe', claim, bob)).json()).code).toBe('ownership_conflict');
  const adopted = await (await request('subscribe', claim)).json();
  expect(adopted.revision).toBe(2);
  expect(listed.slots.some((slot: PushSlotHandle) => slot.slot_id === adopted.slot_id)).toBe(true);
  expect((await request('reconcile', { ...claim, ...condition(adopted) })).status).toBe(200);
  expect((await (await request('subscribe', enable())).json()).code).toBe('slot_cap');
  expect((await (await request('subscriptions')).json()).slots).toHaveLength(6);
  await request('unsubscribe', condition(adopted));
  expect((await (await request('subscribe', enable())).json()).code).toBe('slot_cap');
  const remaining = (await (await request('subscriptions')).json()).slots;
  await request('unsubscribe', condition(remaining[0]));
  expect((await request('subscribe', enable())).status).toBe(201);
});

test('migration discards already-pruned registrations instead of reserving their endpoints forever', async () => {
  const body = enable();
  const path = migrateLegacy([{ address: alice, endpoint: body.subscription.endpoint }], [bob]);
  deleteInactivePubkeys(Date.now() - 30 * 86400_000);
  getDb().close();
  initDb(path);
  registerPubkey(alice, 'test-key');
  createSession(alice, alice, Date.now() + 60_000);
  expect((await (await request('subscriptions')).json()).slots).toEqual([]);
  expect((await request('subscribe', body, bob)).status).toBe(201);
});

test.each([
  'https://FCM.GOOGLEAPIS.COM:443/fcm/send/legacy-alias',
  'https://fcm.googleapis.com/fcm/send/legacy-alias#ignored',
  'https://user:pass@fcm.googleapis.com/fcm/send/legacy-alias',
  'https://fcm.googleapis.com/fcm/other/../send/legacy-alias',
])('migration canonicalizes legacy destination %s for ownership and adoption', async endpoint => {
  const path = migrateLegacy([{ address: alice.toUpperCase(), endpoint }]);
  expect(await deliveredSubscriptions(path)).toEqual([enable('unused', 'legacy-alias').subscription]);
  const listed = await (await request('subscriptions')).json();
  getDb().close();
  initDb(path);
  expect(await (await request('subscriptions')).json()).toEqual(listed);
  const claim = enable(crypto.randomUUID(), 'legacy-alias');
  expect((await (await request('subscribe', claim, bob)).json()).code).toBe('ownership_conflict');
  const response = await request('subscribe', claim);
  expect(response.status).toBe(201);
  const adopted = await response.json();
  expect(adopted).toMatchObject({ slot_id: listed.slots[0].slot_id, revision: 2 });
  expect((await request('reconcile', { ...claim, ...condition(adopted) })).status).toBe(200);
  expect((await (await request('subscriptions')).json()).slots).toHaveLength(1);
});

test('legacy adoption persists the submitted keys, including across restart', async () => {
  const claim = enable();
  const path = migrateLegacy([{ address: alice, endpoint: claim.subscription.endpoint }]);
  const refreshed = { ...claim, subscription: { ...claim.subscription, keys: {
    p256dh: Buffer.alloc(65, 3).toString('base64url'), auth: Buffer.alloc(16, 4).toString('base64url'),
  } } };
  const response = await request('subscribe', refreshed);
  expect(response.status).toBe(201);
  const adopted = await response.json();
  expect(await deliveredSubscriptions(path)).toEqual([refreshed.subscription]);
  getDb().close();
  initDb(path);
  expect((await request('reconcile', { ...refreshed, ...condition(adopted) })).status).toBe(200);
  expect((await (await request('reconcile', { ...claim, ...condition(adopted) })).json()).code).toBe('repair_needed');
});

test.each([alice, bob])('legacy alias collisions retain slots but block adoption until removal (second owner %s)', async secondOwner => {
  const claim = enable(crypto.randomUUID(), 'collision');
  const path = migrateLegacy([
    { address: alice, endpoint: claim.subscription.endpoint },
    { address: secondOwner, endpoint: claim.subscription.endpoint + '#alias' },
  ]);
  const listed = await (await request('subscriptions')).json();
  expect(listed.slots).toHaveLength(secondOwner === alice ? 2 : 1);
  expect(listed.slots.every((slot: { state: string }) => slot.state === 'repair_needed')).toBe(true);
  expect(await deliveredSubscriptions(path)).toEqual([]);
  getDb().close();
  initDb(path);
  expect(await (await request('subscriptions')).json()).toEqual(listed);
  expect((await (await request('subscribe', claim)).json()).code)
    .toBe(secondOwner === alice ? 'repair_needed' : 'ownership_conflict');
  expect((await (await request('subscribe', claim, bob)).json()).code).toBe('ownership_conflict');
  // Removing one alias cannot release another identity's reservation or activate a quarantined slot.
  expect((await request('unsubscribe', condition(listed.slots[0]))).status).toBe(200);
  const remaining = (await (await request('subscriptions', undefined, secondOwner)).json()).slots;
  expect(remaining).toHaveLength(1);
  expect(await deliveredSubscriptions(path)).toEqual([]);
  expect((await (await request('subscribe', claim, secondOwner)).json()).code).toBe('repair_needed');
  expect((await request('unsubscribe', condition(remaining[0]), secondOwner)).status).toBe(200);
  expect((await request('subscribe', claim, bob)).status).toBe(201);
});

test('mutations require authentication, bounded valid bodies and share a removal rate limit', async () => {
  for (const path of ['subscribe', 'reconcile', 'unsubscribe', 'subscriptions']) {
    expect((await request(path, path === 'subscriptions' ? undefined : {}, 'invalid-token')).status).toBe(401);
  }
  for (const body of [null, [], { endpoint: 'https://fcm.googleapis.com/x' }, { ...enable(), expected_revision: -1 }]) {
    expect((await (await request('subscribe', body)).json()).code).toBe('invalid_request');
  }
  expect((await request('subscribe', { extra: 'x'.repeat(8192) })).status).toBe(413);
  limiters.pushMutationLimiter.reset();
  const handle = await (await request('subscribe', enable())).json();
  for (let i = 0; i < 9; i++) expect((await request('unsubscribe', condition(handle))).status).toBe(200);
  const limited = await request('reconcile', { ...enable(handle.installation_id), ...condition(handle) });
  expect(limited.status).toBe(429);
  expect((await limited.json()).code).toBe('rate_limited');
});

test('concurrent additions cannot exceed five slots, without evicting existing bindings', async () => {
  for (let i = 0; i < 4; i++) expect((await request('subscribe', enable())).status).toBe(201);
  const responses = await Promise.all([request('subscribe', enable()), request('subscribe', enable())]);
  expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
  expect((await responses.find(r => r.status === 409)!.json()).code).toBe('slot_cap');
  expect((await (await request('subscriptions')).json()).slots).toHaveLength(5);
});

test('URL destination aliases cannot create a second ownership binding', async () => {
  const original = enable(crypto.randomUUID(), 'alias-token');
  expect((await request('subscribe', original)).status).toBe(201);
  for (const endpoint of [
    'https://FCM.GOOGLEAPIS.COM:443/fcm/send/alias-token',
    'https://fcm.googleapis.com/fcm/other/../send/alias-token',
  ]) {
    const response = await request('subscribe', { ...enable(), subscription: { endpoint, keys } }, bob);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('ownership_conflict');
  }
  for (const endpoint of [original.subscription.endpoint + '#other', 'https://user:pass@fcm.googleapis.com/fcm/send/alias-token']) {
    expect((await request('subscribe', { ...enable(), subscription: { endpoint, keys } }, bob)).status).toBe(400);
  }
});

test('conditional reconciliation replaces an owned endpoint in its existing slot', async () => {
  const first = enable();
  const created = await (await request('subscribe', first)).json();
  const replacement = enable(first.installation_id, 'replacement');
  const response = await request('reconcile', { ...replacement, ...condition(created) });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...created, revision: 2 });
  expect((await (await request('subscriptions')).json()).slots).toMatchObject([
    { ...created, revision: 2, state: 'active' },
  ]);
  expect((await request('subscribe', { ...enable(), subscription: first.subscription }, bob)).status).toBe(201);
  // A removal that began from the old revision cannot revoke the replacement.
  expect((await request('unsubscribe', condition(created))).status).toBe(409);
  expect((await request('reconcile', { ...replacement, ...condition(created) })).status).toBe(409);
});

test('an endpoint cannot transfer across authenticated identities and lists reveal no secrets', async () => {
  const body = enable();
  const created = await request('subscribe', body);
  expect(created.status).toBe(201);
  const handle = await created.json();
  expect(handle).toMatchObject({ installation_id: body.installation_id, revision: 1 });
  expect(typeof handle.slot_id).toBe('string');
  const conflict = await request('subscribe', enable(crypto.randomUUID(), body.subscription.endpoint.split('/').at(-1)), bob);
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).code).toBe('ownership_conflict');
  const own = await (await request('subscriptions')).json();
  expect(own.slots).toHaveLength(1);
  expect(own.slots[0]).toMatchObject({ ...handle, state: 'active', label: 'Browser' });
  expect(JSON.stringify(own)).not.toContain('https://');
  expect(JSON.stringify(own)).not.toContain(keys.auth);
  expect((await (await request('subscriptions', undefined, bob)).json()).slots).toEqual([]);
});
