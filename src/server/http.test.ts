import { describe, expect, test } from 'bun:test';
import { getClientIp } from './http.ts';

function fakeServer(address: string | null) {
  return { requestIP: () => (address === null ? null : { address }) };
}

describe('getClientIp', () => {
  test('returns the peer IP when no trusted proxies are configured, ignoring X-Forwarded-For', () => {
    const req = new Request('https://chat.example/api/auth/challenge', {
      headers: { 'X-Forwarded-For': '203.0.113.7, 198.51.100.1' },
    });
    expect(getClientIp(req, fakeServer('198.51.100.1'))).toBe('198.51.100.1');
  });

  test('returns unknown when the server cannot report a peer address', () => {
    const req = new Request('https://chat.example/api/auth/challenge', {
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(getClientIp(req, fakeServer(null))).toBe('unknown');
  });
});
