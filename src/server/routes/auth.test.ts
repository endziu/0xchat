import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { handleAuthChallenge, handleAuthSession } from './auth.ts';
import { getDb, initDb } from '../db.ts';
import { authChallengeLimiter, authSessionLimiter } from '../rate-limiters.ts';
import { noOpSchedule } from '../rate-limit.test-utils.ts';
import type { Context } from '../http.ts';

const address = `0x${'2'.repeat(40)}`;

const signer = privateKeyToAccount(`0x${'99'.repeat(32)}` as `0x${string}`);
const signerAddress = signer.address.toLowerCase();

const TEST_DB = `auth-route-test-${Date.now()}.db`;

beforeAll(() => {
  // Route tests must not start real cleanup timers on the production singletons.
  authChallengeLimiter.setSchedule(noOpSchedule);
  authSessionLimiter.setSchedule(noOpSchedule);
  initDb(TEST_DB);
});

afterAll(() => {
  getDb().close();
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(TEST_DB + suffix); } catch {}
  }
});

function postContext(ip: string, path: string, body: unknown, origin?: string): Context {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (origin) headers.set('Origin', origin);
  const req = new Request(`https://chat.example${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { req, url: new URL(req.url), path, method: 'POST', ip };
}

const challengeContext = (ip: string): Context => postContext(ip, '/api/auth/challenge', { address });
const sessionContext = (ip: string): Context => postContext(ip, '/api/auth/session', {});

describe('auth rate limiting', () => {
  test('challenge: 10 per ip allowed, then 429', async () => {
    const ip = `auth-challenge-test-${Math.random()}`;
    for (let i = 0; i < 10; i++) {
      expect((await handleAuthChallenge(challengeContext(ip))).status).toBe(200);
    }
    expect((await handleAuthChallenge(challengeContext(ip))).status).toBe(429);
  });

  test('session: limit checked before body, 429 after 10 per ip', async () => {
    const ip = `auth-session-test-${Math.random()}`;
    for (let i = 0; i < 10; i++) {
      expect((await handleAuthSession(sessionContext(ip))).status).toBe(400);
    }
    expect((await handleAuthSession(sessionContext(ip))).status).toBe(429);
  });
});

describe('redemption origin binding', () => {
  const appOrigin = 'https://chat.example';
  const evilOrigin = 'https://evil.example';

  async function issueFrom(ip: string, origin: string): Promise<{ challenge: string; nonce: string }> {
    const response = await handleAuthChallenge(
      postContext(ip, '/api/auth/challenge', { address: signerAddress }, origin),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { challenge: string; nonce: string };
  }

  test('rejects session redemption from a different origin than issuance', async () => {
    const ip = `auth-origin-${Math.random()}`;
    const { challenge, nonce } = await issueFrom(ip, appOrigin);
    const signature = await signer.signMessage({ message: challenge });
    const response = await handleAuthSession(
      postContext(ip, '/api/auth/session', { nonce, signature, address: signerAddress }, evilOrigin),
    );
    expect(response.status).toBe(401);
  });

  test('rejects session redemption without a usable origin', async () => {
    const ip = `auth-origin-${Math.random()}`;
    const { challenge, nonce } = await issueFrom(ip, appOrigin);
    const signature = await signer.signMessage({ message: challenge });
    const response = await handleAuthSession(
      postContext(ip, '/api/auth/session', { nonce, signature, address: signerAddress }, 'not an origin'),
    );
    expect(response.status).toBe(400);
  });

  test('still creates a session redeemed from its issuing origin', async () => {
    const ip = `auth-origin-${Math.random()}`;
    const { challenge, nonce } = await issueFrom(ip, appOrigin);
    const signature = await signer.signMessage({ message: challenge });
    const response = await handleAuthSession(
      postContext(ip, '/api/auth/session', { nonce, signature, address: signerAddress }, appOrigin),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { token: string };
    expect(data.token).toBeTruthy();
  });
});
