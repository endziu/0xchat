import { describe, expect, test } from 'bun:test';
import { getClientIp } from './http.ts';

function fakeServer(address: string | null) {
  return { requestIP: () => (address === null ? null : { address }) };
}

describe('getClientIp', () => {
  // Config-dependent behavior (trusted vs unset TRUSTED_PROXY_IPS) is covered
  // deterministically in server.test.ts, which pins the env per spawned server;
  // the module captures the env at import time, so in-process tests must stay
  // config-independent.
  test('returns unknown when the server cannot report a peer address', () => {
    const req = new Request('https://chat.example/api/auth/challenge', {
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(getClientIp(req, fakeServer(null))).toBe('unknown');
  });
});
