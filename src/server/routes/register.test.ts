import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { handleRegister, handleRegisterChallenge } from './register.ts';
import { initDb } from '../db.ts';
import { registerChallengeLimiter, registerLimiter } from '../rate-limiters.ts';
import { noOpSchedule } from '../rate-limit.test-utils.ts';
import type { Context } from '../http.ts';

beforeAll(() => {
  // Route tests must not start real cleanup timers on the production singletons.
  registerChallengeLimiter.setSchedule(noOpSchedule);
  registerLimiter.setSchedule(noOpSchedule);
});

beforeEach(() => {
  initDb(':memory:');
});

const privateKey = `0x${'77'.repeat(32)}` as const;
const address = privateKeyToAccount(privateKey).address.toLowerCase();
const publicKey = bytesToHex(secp.getPublicKey(hexToBytes(privateKey), true));

function context(ip: string): Context {
  const req = new Request('https://chat.example/api/register/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, pubkey: publicKey }),
  });
  return {
    req,
    url: new URL(req.url),
    path: '/api/register/challenge',
    method: 'POST',
    ip,
  };
}

describe('registration key validation', () => {
  test('rejects malformed, off-curve, and address-mismatched keys before storage', async () => {
    const invalidKeys = ['0x1234', `0x02${'00'.repeat(32)}`, bytesToHex(
      secp.getPublicKey(hexToBytes(`0x${'66'.repeat(32)}`), true),
    )];

    for (const pubkey of invalidKeys) {
      const req = new Request('https://chat.example/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          pubkey,
          signature: `0x${'ab'.repeat(65)}`,
          nonce: 'unused',
        }),
      });
      const response = await handleRegister({
        req,
        url: new URL(req.url),
        path: '/api/register',
        method: 'POST',
        ip: `registration-validation-${Math.random()}`,
      });
      expect(response.status).toBe(400);
    }
  });
});

describe('registration challenge rate limit', () => {
  test('limits issuance before accepting more challenge state', async () => {
    const ip = `registration-test-${Math.random()}`;
    for (let count = 0; count < 10; count++) {
      expect((await handleRegisterChallenge(context(ip))).status).toBe(200);
    }
    expect((await handleRegisterChallenge(context(ip))).status).toBe(429);
  });
});

describe('registration write rate limit', () => {
  test('one IP cannot open a fresh registration bucket by cycling identities', async () => {
    const registrationIp = `registration-write-${Math.random()}`;

    for (let count = 1; count <= 11; count++) {
      const identityPrivateKey = `0x${count.toString(16).padStart(2, '0').repeat(32)}` as const;
      const identityAddress = privateKeyToAccount(identityPrivateKey).address.toLowerCase();
      const identityPubkey = bytesToHex(secp.getPublicKey(hexToBytes(identityPrivateKey), true));
      const challengeReq = new Request('https://chat.example/api/register/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: identityAddress, pubkey: identityPubkey }),
      });
      const challengeResponse = await handleRegisterChallenge({
        req: challengeReq,
        url: new URL(challengeReq.url),
        path: '/api/register/challenge',
        method: 'POST',
        ip: `challenge-${count}-${Math.random()}`,
      });
      const { challenge, nonce } = await challengeResponse.json() as { challenge: string; nonce: string };
      const signature = await privateKeyToAccount(identityPrivateKey).signMessage({ message: challenge });
      const registerReq = new Request('https://chat.example/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: identityAddress,
          pubkey: identityPubkey,
          signature,
          nonce,
        }),
      });
      const response = await handleRegister({
        req: registerReq,
        url: new URL(registerReq.url),
        path: '/api/register',
        method: 'POST',
        ip: registrationIp,
      });

      expect(response.status).toBe(count <= 10 ? 200 : 429);
    }
  });
});
