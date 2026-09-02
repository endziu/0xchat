import { describe, expect, test } from 'bun:test';
import { handleAuthChallenge, handleAuthSession } from './auth.ts';
import type { Context } from '../http.ts';

const address = `0x${'2'.repeat(40)}`;

function challengeContext(ip: string): Context {
  const req = new Request('https://chat.example/api/auth/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  return { req, url: new URL(req.url), path: '/api/auth/challenge', method: 'POST', ip };
}

function sessionContext(ip: string): Context {
  const req = new Request('https://chat.example/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return { req, url: new URL(req.url), path: '/api/auth/session', method: 'POST', ip };
}

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
