import { describe, expect, test } from 'bun:test';
import { handleAuthChallenge } from './auth.ts';
import type { Context } from '../http.ts';

function context(ip: string): Context {
  const req = new Request('https://chat.example/api/auth/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: `0x${'12'.repeat(20)}` }),
  });
  return {
    req,
    url: new URL(req.url),
    path: '/api/auth/challenge',
    method: 'POST',
    ip,
  };
}

describe('authentication challenge rate limit', () => {
  test('keeps challenge issuance limited to ten requests per minute', async () => {
    const ip = `authentication-test-${Math.random()}`;
    for (let count = 0; count < 10; count++) {
      expect((await handleAuthChallenge(context(ip))).status).toBe(200);
    }
    expect((await handleAuthChallenge(context(ip))).status).toBe(429);
  });
});
