import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSignedMessageEnvelope } from '../../client/lib/message-envelope.ts';
import { createSession, deleteInactivePubkeys, getDb, initDb, registerPubkey } from '../db.ts';
import { messageIpLimiter, messageLimiter } from '../rate-limiters.ts';
import { noOpSchedule } from '../rate-limit.test-utils.ts';
import { handleSendMessage } from './messages.ts';
import type { Context } from '../http.ts';

beforeAll(() => {
  messageLimiter.setSchedule(noOpSchedule);
  messageIpLimiter.setSchedule(noOpSchedule);
});

beforeEach(() => {
  initDb(':memory:');
});

function identity(byte: string) {
  const privateKey = `0x${byte.repeat(32)}` as const;
  return {
    privateKey,
    address: privateKeyToAccount(privateKey).address.toLowerCase(),
    publicKey: bytesToHex(secp.getPublicKey(hexToBytes(privateKey), true)),
  };
}

const alice = identity('77');
const bob = identity('88');
const recipient = identity('99');

function messageContext(ip: string, token: string, body: unknown = { version: 2 }): Context {
  const req = new Request('https://chat.example/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return {
    req,
    url: new URL(req.url),
    path: '/api/messages',
    method: 'POST',
    ip,
  };
}

describe('message rate limiting', () => {
  test('one identity can send 120 messages and its 121st is rejected', async () => {
    const ip = `single-identity-${Math.random()}`;
    registerPubkey(recipient.address, recipient.publicKey);
    createSession('alice-token', alice.address, Date.now() + 60_000);

    for (let count = 0; count < 121; count++) {
      const envelope = await createSignedMessageEnvelope('hello', 300, alice, recipient.address, recipient.publicKey);
      const response = await handleSendMessage(messageContext(ip, 'alice-token', envelope));
      expect(response.status).toBe(count < 120 ? 201 : 429);
    }
    expect(getDb().query('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 120 });

    // A different address still has its own allowance on this IP.
    createSession('bob-token', bob.address, Date.now() + 60_000);
    const envelope = await createSignedMessageEnvelope('hello', 300, bob, recipient.address, recipient.publicKey);
    expect((await handleSendMessage(messageContext(ip, 'bob-token', envelope))).status).toBe(201);
  });

  test('two identities sharing an IP each get 120 messages before the aggregate cap', async () => {
    const ip = `shared-ip-${Math.random()}`;
    registerPubkey(recipient.address, recipient.publicKey);
    for (const sender of [alice, bob]) {
      createSession(sender.address, sender.address, Date.now() + 60_000);
      for (let count = 0; count < 120; count++) {
        const envelope = await createSignedMessageEnvelope('hello', 300, sender, recipient.address, recipient.publicKey);
        expect((await handleSendMessage(messageContext(ip, sender.address, envelope))).status).toBe(201);
      }
    }
    createSession('fresh-token', recipient.address, Date.now() + 60_000);
    expect((await handleSendMessage(messageContext(ip, 'fresh-token'))).status).toBe(429);
    expect(getDb().query('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 240 });
    expect((await handleSendMessage(messageContext(`${ip}-other`, 'fresh-token'))).status).toBe(400);
  });

  test('one IP cannot open a fresh message bucket by cycling identities', async () => {
    const ip = `identity-cycle-${Math.random()}`;

    for (let count = 0; count < 240; count++) {
      const token = `cycle-token-${count}`;
      createSession(token, `0x${count.toString(16).padStart(40, '0')}`, Date.now() + 60_000);
      expect((await handleSendMessage(messageContext(ip, token))).status).toBe(400);
    }

    createSession('cycle-token-over-limit', `0x${'f'.repeat(40)}`, Date.now() + 60_000);
    expect((await handleSendMessage(messageContext(ip, 'cycle-token-over-limit'))).status).toBe(429);
  });
});

test('a pruned recipient cannot receive messages until it re-registers', async () => {
  const ip = `pruned-recipient-${Math.random()}`;
  createSession('sender-token', alice.address, Date.now() + 60_000);
  registerPubkey(recipient.address, recipient.publicKey);
  getDb().query('UPDATE pubkeys SET last_active_at = ? WHERE address = ?').run(1_000, recipient.address);
  expect(deleteInactivePubkeys(1_500)).toBe(1);
  const envelope = await createSignedMessageEnvelope('hello', 300, alice, recipient.address, recipient.publicKey);

  const rejected = await handleSendMessage(messageContext(ip, 'sender-token', envelope));
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toEqual({ error: 'Recipient not registered' });
  expect(getDb().query('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });

  registerPubkey(recipient.address, recipient.publicKey);
  expect((await handleSendMessage(messageContext(ip, 'sender-token', envelope))).status).toBe(201);
});
