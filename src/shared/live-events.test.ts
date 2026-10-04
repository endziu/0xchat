import { requireAddress } from './address'
import { expect, test } from 'bun:test'
import * as secp from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from 'viem'
import { LIVE_EVENT_TYPES, parseLiveEvent } from './live-events'
import { MESSAGE_ENVELOPE_VERSION } from './message-envelope'

const alice = requireAddress(`0x${'a1'.repeat(20)}`)
const bob = requireAddress(`0x${'b2'.repeat(20)}`)
const ephemeral = bytesToHex(secp.getPublicKey(hexToBytes(`0x${'33'.repeat(32)}`), true))

// Structurally valid, but the signature is never checked: that is the consumer's trust decision.
const delivered = {
  version: MESSAGE_ENVELOPE_VERSION,
  id: `0x${'44'.repeat(16)}`,
  sender: alice,
  recipient: bob,
  ttl: 300,
  ct_recipient: `0x${'55'.repeat(32)}`,
  ephemeral_pub_recipient: ephemeral,
  iv_recipient: `0x${'66'.repeat(12)}`,
  ct_sender: `0x${'77'.repeat(32)}`,
  ephemeral_pub_sender: ephemeral,
  iv_sender: `0x${'88'.repeat(12)}`,
  signature: `0x${'00'.repeat(65)}`,
  delivery_policy: 'recipient-opening',
  created_at: 1000,
  opened_at: null,
  expires_at: 86401000,
}
const expiryUpdate = {
  id: delivered.id, sender: alice, recipient: bob, delivery_policy: 'recipient-opening',
  created_at: 1000, opened_at: 2000, expires_at: 302000,
}
const cleared = { address: alice, cleared_at: 2000 }
const departed = { address: alice }

test('names every live event on the wire', () => {
  expect([...LIVE_EVENT_TYPES].sort()).toEqual(['conversation-cleared', 'expiry-update', 'message', 'user:disconnected'])
})

test.each([
  ['message', delivered],
  ['message', { ...delivered, opened_at: 2000, expires_at: 302000 }],
  ['expiry-update', expiryUpdate],
  ['expiry-update', { ...expiryUpdate, opened_at: null, expires_at: 86401000 }],
  ['conversation-cleared', cleared],
  ['conversation-cleared', { ...cleared, cleared_at: 0 }],
  ['user:disconnected', departed],
])('accepts a valid %s payload', (type, payload) => {
  expect(parseLiveEvent(type, JSON.stringify(payload))).toEqual({ type, data: payload } as never)
})

test.each([
  ['an unknown name', 'ping', '{}'],
  ['an inherited property name', 'constructor', JSON.stringify(departed)],
  ['an inherited property name', '__proto__', JSON.stringify(departed)],
  ['invalid JSON', 'message', 'not-json'],
  ['invalid JSON', 'expiry-update', '{"id":'],
  ['invalid JSON', 'conversation-cleared', ''],
  ['invalid JSON', 'user:disconnected', 'also-not-json'],
  ['a non-object', 'message', 'null'],
  ['a non-object', 'expiry-update', '"junk"'],
  ['a non-object', 'conversation-cleared', '[]'],
  ['a non-object', 'user:disconnected', '42'],
  ['an unexpected key', 'message', JSON.stringify({ ...delivered, extra: true })],
  ['a missing key', 'message', JSON.stringify({ ...delivered, signature: undefined })],
  ['a malformed envelope', 'message', JSON.stringify({ ...delivered, sender: '0xpeer' })],
  ['an invalid ephemeral key', 'message', JSON.stringify({ ...delivered, ephemeral_pub_sender: `0x02${'00'.repeat(32)}` })],
  ['an inconsistent lifecycle', 'message', JSON.stringify({ ...delivered, expires_at: 301000 })],
  ['an unknown delivery policy', 'message', JSON.stringify({ ...delivered, delivery_policy: 'legacy' })],
  ['an unexpected key', 'expiry-update', JSON.stringify({ ...expiryUpdate, extra: true })],
  ['a malformed message ID', 'expiry-update', JSON.stringify({ ...expiryUpdate, id: 'm1' })],
  ['a malformed participant', 'expiry-update', JSON.stringify({ ...expiryUpdate, recipient: bob.toUpperCase() })],
  ['a fractional deadline', 'expiry-update', JSON.stringify({ ...expiryUpdate, expires_at: 1.5 })],
  ['a missing address', 'conversation-cleared', JSON.stringify({ cleared_at: 2000 })],
  ['a malformed address', 'conversation-cleared', JSON.stringify({ ...cleared, address: '0xpeer' })],
  ['a checksummed address', 'conversation-cleared', JSON.stringify({ ...cleared, address: `0x${'A1'.repeat(20)}` })],
  ['a negative clear time', 'conversation-cleared', JSON.stringify({ ...cleared, cleared_at: -1 })],
  ['a fractional clear time', 'conversation-cleared', JSON.stringify({ ...cleared, cleared_at: 1.5 })],
  ['a missing address', 'user:disconnected', '{}'],
  ['a malformed address', 'user:disconnected', JSON.stringify({ address: '0xpeer' })],
  ['a checksummed address', 'user:disconnected', JSON.stringify({ address: `0x${'A1'.repeat(20)}` })],
  ['a non-string address', 'user:disconnected', JSON.stringify({ address: 42 })],
])('rejects %s (%s)', (_reason, type, data) => {
  expect(parseLiveEvent(type, data)).toBeNull()
})

test('returns only the checked user:disconnected fields', () => {
  expect(parseLiveEvent('user:disconnected', JSON.stringify({ ...departed, extra: 1 }))).toEqual({ type: 'user:disconnected', data: departed })
})
