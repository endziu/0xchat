import { beforeEach, describe, expect, test } from 'bun:test';
import { getClientIp, readJson } from './http.ts';
import { authChallengeLimiter } from './rate-limiters.ts';
import { createFetch } from './router.ts';
import { parseTrustedProxyIps } from './trusted-proxy.ts';

function fakeServer(address: string | null) {
  return { requestIP: () => (address === null ? null : { address }) };
}

describe('readJson', () => {
  test('accepts JSON at the exact byte limit with UTF-8 split across chunks', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x22, 0xf0, 0x9f]));
        controller.enqueue(new Uint8Array([0x98, 0x80, 0x22]));
        controller.close();
      },
    });
    expect(await readJson(new Request('https://chat.example', { method: 'POST', body }), 6)).toBe('😀');
  });

  test('returns 400 for missing, empty or malformed JSON', async () => {
    for (const body of [undefined, '', '{']) {
      const result = await readJson(new Request('https://chat.example', { method: 'POST', body }), 8192);
      expect(result).toBeInstanceOf(Response);
      if (!(result instanceof Response)) throw new Error('Expected an error response');
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ error: 'Invalid JSON' });
    }
  });

  test('counts streamed bytes regardless of Content-Length and stops at the limit', async () => {
    for (const contentLength of [undefined, '1']) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('"😀"'));
          // Leave the stream open: rejection must not wait for the rest.
        },
        cancel() { cancelled = true; },
      });
      const req = new Request('https://chat.example', {
        method: 'POST', body,
        headers: contentLength ? { 'Content-Length': contentLength } : {},
      });
      const result = await readJson(req, 5);
      expect(result).toBeInstanceOf(Response);
      if (!(result instanceof Response)) throw new Error('Expected an error response');
      expect(result.status).toBe(413);
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    }
  });
});

describe('getClientIp', () => {
  test('returns unknown when the server cannot report a peer address', () => {
    const req = new Request('https://chat.example/api/auth/challenge', {
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(getClientIp(req, fakeServer(null), new Set())).toBe('unknown');
  });
});

// The router is given its trust set directly, so both configurations run in
// this process; parsing TRUSTED_PROXY_IPS itself is covered in
// trusted-proxy.test.ts.
describe('trusted-proxy X-Forwarded-For rate limiting', () => {
  const proxy = fakeServer('127.0.0.1');

  beforeEach(() => authChallengeLimiter.reset());

  // Invalid-address payload: 400 when allowed through, 429 when rate limited.
  async function authChallenge(fetch: ReturnType<typeof createFetch>, forwardedFor: string): Promise<number> {
    const req = new Request('http://chat.example/api/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor },
      body: JSON.stringify({}),
    });
    return (await fetch(req, proxy)).status;
  }

  test('with the proxy trusted, each X-Forwarded-For client gets its own bucket', async () => {
    const fetch = createFetch({ trustedProxies: parseTrustedProxyIps('127.0.0.1, ::1') });
    for (let i = 0; i < 10; i++) {
      expect(await authChallenge(fetch, '203.0.113.7')).toBe(400);
    }
    expect(await authChallenge(fetch, '203.0.113.7')).toBe(429);
    // A different XFF client is unaffected by the first client's 429.
    expect(await authChallenge(fetch, '203.0.113.8')).toBe(400);
  });

  test('with no trusted proxies, spoofed X-Forwarded-For shares the proxy bucket', async () => {
    const fetch = createFetch({ trustedProxies: parseTrustedProxyIps('') });
    for (let i = 0; i < 10; i++) {
      expect(await authChallenge(fetch, '203.0.113.7')).toBe(400);
    }
    expect(await authChallenge(fetch, '203.0.113.7')).toBe(429);
    // Spoofed XFF must not open a fresh bucket: still limited on the peer IP.
    expect(await authChallenge(fetch, '203.0.113.8')).toBe(429);
  });
});
