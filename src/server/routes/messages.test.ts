import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createSession, initDb } from '../db.ts';
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

function messageContext(ip: string, token: string): Context {
  const req = new Request('https://chat.example/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ version: 2 }),
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
