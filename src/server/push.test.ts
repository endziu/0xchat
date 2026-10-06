import { requireAddress } from '../shared/address.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, deleteInactivePubkeys, deleteRegistration, getDb, getPushSubscriptionsForAddress, initDb, registerPubkey, savePushSubscription } from './db.ts'
import { pushNotify, setPushSender, type SendPush } from './push.ts'
import { addClient, removeClient } from './sse.ts'
import { createFetch } from './router.ts'
import * as limiters from './rate-limiters.ts'
import { identity } from './test-identity.ts'
import { createSignedMessageEnvelope } from '../shared/seal-envelope.ts'
import { DELIVERY_CAPABILITY } from '../shared/message-envelope.ts'

const alice = requireAddress(`0x${'a'.repeat(40)}`)
const keys = { p256dh: 'p256dh-key', auth: 'auth-key' }
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`
let sent: Array<{ endpoint: string; TTL: number }>
let respond: (endpoint: string) => Promise<unknown>

beforeEach(() => {
  initDb(':memory:')
  registerPubkey(alice, 'test-key')
  sent = []
  respond = async () => undefined
  const send: SendPush = async (subscription, options) => {
    sent.push({ endpoint: subscription.endpoint, TTL: options.TTL })
    return respond(subscription.endpoint)
  }
  setPushSender(send)
})
afterEach(() => setPushSender(undefined))

const rejectWith = (statusCode: number) => async () => { throw Object.assign(new Error('rejected'), { statusCode }) }
const endpoints = () => getPushSubscriptionsForAddress(alice).map(row => row.endpoint)

test('wakes every subscription of the recipient with the remaining whole seconds as TTL', async () => {
  savePushSubscription(alice, { endpoint: endpoint('one'), ...keys })
  savePushSubscription(alice, { endpoint: endpoint('two'), ...keys })

  await pushNotify(alice, Date.now() + 90_500)

  expect(sent.map(item => item.endpoint).sort()).toEqual([endpoint('one'), endpoint('two')])
  expect(sent.every(item => item.TTL === 90)).toBe(true)
})

test('an accepted message wakes the recipient until its unopened retention deadline', async () => {
  const ttl = 24 * 60 * 60
  const sender = identity('31')
  const recipient = identity('42')
  for (const person of [sender, recipient]) {
    registerPubkey(person.address, person.publicKey)
    createSession(person.address, person.address, Date.now() + 60_000)
  }
  for (const limiter of Object.values(limiters)) limiter.reset()
  savePushSubscription(recipient.address, { endpoint: endpoint('recipient'), ...keys })
  const server = Bun.serve({ port: 0, fetch: createFetch() })
  try {
    const envelope = await createSignedMessageEnvelope('hello', 5, sender, recipient.address, recipient.publicKey)
    const response = await fetch(new URL('/api/messages', server.url), { method: 'POST', body: JSON.stringify(envelope),
      headers: { Authorization: `Bearer ${sender.address}`, 'Content-Type': 'application/json',
        'X-0xChat-Delivery-Capability': DELIVERY_CAPABILITY } })
    expect(response.status).toBe(201)
    await Bun.sleep(10)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.endpoint).toBe(endpoint('recipient'))
    expect(sent[0]!.TTL).toBeGreaterThanOrEqual(ttl - 1)
    expect(sent[0]!.TTL).toBeLessThanOrEqual(ttl)
  } finally {
    server.stop(true)
  }
})

test('sends nothing with less than a second left', async () => {
  savePushSubscription(alice, { endpoint: endpoint('one'), ...keys })
  await pushNotify(alice, Date.now() + 900)
  expect(sent).toEqual([])
})

test('sends nothing while the recipient has an attentive connection', async () => {
  savePushSubscription(alice, { endpoint: endpoint('one'), ...keys })
  const ctrl = {} as ReadableStreamDefaultController
  addClient(alice, '127.0.0.1', ctrl)
  try {
    await pushNotify(alice, Date.now() + 60_000)
    expect(sent).toEqual([])
  } finally {
    removeClient(alice, ctrl)
  }
})

test.each([401, 403, 404, 410])('removes a subscription the push service rejects with %d', async (status) => {
  savePushSubscription(alice, { endpoint: endpoint('dead'), ...keys })
  savePushSubscription(alice, { endpoint: endpoint('live'), ...keys })
  respond = async (target) => target === endpoint('dead') ? rejectWith(status)() : undefined

  await pushNotify(alice, Date.now() + 60_000)
  expect(endpoints()).toEqual([endpoint('live')])
})

test('keeps a subscription after a temporary or unknown failure, without retrying', async () => {
  savePushSubscription(alice, { endpoint: endpoint('one'), ...keys })
  respond = rejectWith(503)
  await pushNotify(alice, Date.now() + 60_000)
  respond = async () => { throw new Error(`socket hang up for ${endpoint('one')}`) }
  await pushNotify(alice, Date.now() + 60_000)

  expect(sent).toHaveLength(2)
  expect(endpoints()).toEqual([endpoint('one')])
})

test('pruning and registration deletion remove subscriptions', () => {
  savePushSubscription(alice, { endpoint: endpoint('one'), ...keys })
  getDb().run('UPDATE pubkeys SET last_active_at = 0')
  deleteInactivePubkeys(1)
  expect(endpoints()).toEqual([])

  registerPubkey(alice, 'test-key')
  savePushSubscription(alice, { endpoint: endpoint('two'), ...keys })
  deleteRegistration(alice)
  expect(endpoints()).toEqual([])
})

test('migration keeps live slot endpoints and drops the slot tables', () => {
  const directory = mkdtempSync(join(tmpdir(), 'push-migration-'))
  const path = join(directory, 'chat.db')
  try {
    const legacy = new Database(path)
    legacy.run(`CREATE TABLE push_slots (slot_id TEXT PRIMARY KEY, address TEXT NOT NULL, installation_id TEXT NOT NULL,
      revision INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active', endpoint TEXT, p256dh TEXT, auth TEXT,
      legacy INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    legacy.run('CREATE TABLE push_revocations (slot_id TEXT PRIMARY KEY, address TEXT, installation_id TEXT, revision INTEGER)')
    legacy.run('CREATE TABLE push_work (slot_id TEXT PRIMARY KEY, revision INTEGER)')
    const insert = legacy.query(`INSERT INTO push_slots (slot_id, address, installation_id, revision, state, endpoint, p256dh, auth, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, 1)`)
    insert.run('live', alice, 'i1', 'active', endpoint('live'), 'p', 'a')
    insert.run('dead', alice, 'i2', 'repair_needed', null, null, null)
    insert.run('conflict', alice, 'i3', 'repair_needed', endpoint('conflict'), 'p', 'a')
    legacy.close()

    getDb().close()
    initDb(path)

    expect(endpoints()).toEqual([endpoint('live')])
    const tables = getDb().query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'push_%'").all()
    expect(tables).toEqual([{ name: 'push_subscriptions' }])
    getDb().close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
    initDb(':memory:')
  }
})
