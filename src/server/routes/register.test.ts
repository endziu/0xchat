import { describe, expect, test } from 'bun:test';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { handleRegister, handleRegisterChallenge } from './register.ts';
import type { Context } from '../http.ts';

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
