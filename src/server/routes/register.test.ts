import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { handleRegister, handleRegisterChallenge } from './register.ts';
import { getDb, initDb } from '../db.ts';
import { registerChallengeLimiter, registerLimiter } from '../rate-limiters.ts';
import { noOpSchedule } from '../rate-limit.test-utils.ts';
import type { Context } from '../http.ts';

const TEST_DB = `register-route-test-${Date.now()}.db`;

beforeAll(() => {
  // Route tests must not start real cleanup timers on the production singletons.
  registerChallengeLimiter.setSchedule(noOpSchedule);
  registerLimiter.setSchedule(noOpSchedule);
  initDb(TEST_DB);
});

afterAll(() => {
  getDb().close();
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(TEST_DB + suffix); } catch {}
  }
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

describe('redemption origin binding', () => {
  const appOrigin = 'https://chat.example';
  const evilOrigin = 'https://evil.example';

  function originContext(ip: string, path: string, body: unknown, origin: string): Context {
    const req = new Request(`https://chat.example${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body),
    });
    return { req, url: new URL(req.url), path, method: 'POST', ip };
  }

  async function issueFrom(ip: string, origin: string): Promise<{ challenge: string; nonce: string }> {
    const response = await handleRegisterChallenge(
      originContext(ip, '/api/register/challenge', { address, pubkey: publicKey }, origin),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { challenge: string; nonce: string };
  }

  test('rejects redemption from a different origin than issuance', async () => {
    const ip = `register-origin-${Math.random()}`;
    const { challenge, nonce } = await issueFrom(ip, appOrigin);
    const signature = await privateKeyToAccount(privateKey).signMessage({ message: challenge });
    const response = await handleRegister(
      originContext(ip, '/api/register', { address, pubkey: publicKey, signature, nonce }, evilOrigin),
    );
    expect(response.status).toBe(401);
  });

  test('rejects redemption without a usable origin', async () => {
    const ip = `register-origin-${Math.random()}`;
    const { challenge, nonce } = await issueFrom(ip, appOrigin);
    const signature = await privateKeyToAccount(privateKey).signMessage({ message: challenge });
    const response = await handleRegister(
      originContext(ip, '/api/register', { address, pubkey: publicKey, signature, nonce }, 'not an origin'),
    );
    expect(response.status).toBe(400);
  });

  test('still redeems a challenge from its issuing origin', async () => {
    const ip = `register-origin-${Math.random()}`;
    const { challenge, nonce } = await issueFrom(ip, appOrigin);
    const signature = await privateKeyToAccount(privateKey).signMessage({ message: challenge });
    const response = await handleRegister(
      originContext(ip, '/api/register', { address, pubkey: publicKey, signature, nonce }, appOrigin),
    );
    expect(response.status).toBe(200);
  });
});
