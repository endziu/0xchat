import { randomBytes } from 'node:crypto';
import { addClient, connectionCount, removeClient } from '../sse.ts';
import { json, getSessionAddress } from '../http.ts';
import { sseTokenLimiter } from '../rate-limiters.ts';
import { MAX_SSE_CONNECTIONS_PER_ADDRESS, SECURITY_HEADERS, log, warn, error } from '../constants.ts';
import type { Context } from '../http.ts';

interface SseTokenEntry {
  address: string;
  expiresAt: number;
}

const sseTokens = new Map<string, SseTokenEntry>();

export function cleanupSseTokens(): void {
  const now = Date.now();
  for (const [token, entry] of sseTokens) {
    if (entry.expiresAt < now) sseTokens.delete(token);
  }
}

export async function handleGetSSEToken({ req, ip }: Context): Promise<Response> {
  if (sseTokenLimiter.hit(ip)) {
    warn('[rate-limit] sse-token', ip);
    return json({ error: 'Too many requests' }, 429);
  }

  const address = getSessionAddress(req);
  if (!address) {
    warn('[unauth] sse token no session', ip);
    return json({ error: 'Unauthorized' }, 401);
  }

  const sseToken = randomBytes(16).toString('hex');
  sseTokens.set(sseToken, { address, expiresAt: Date.now() + 30_000 });

  log('[sse-token]', address);
  return json({ sse_token: sseToken });
}

export async function handleSSE({ url, ip }: Context): Promise<Response> {
  const sseToken = url.searchParams.get('token');
  if (!sseToken) return json({ error: 'Missing token' }, 401);

  const tokenEntry = sseTokens.get(sseToken);
  if (!tokenEntry || tokenEntry.expiresAt < Date.now()) {
    sseTokens.delete(sseToken);
    return json({ error: 'Invalid or expired token' }, 401);
  }

  const address = tokenEntry.address;

  // Checked before the token is consumed: a rejected client can retry the
  // same token once a slot frees (EventSource reconnects with the same URL).
  if (connectionCount(address) >= MAX_SSE_CONNECTIONS_PER_ADDRESS) {
    warn('[sse]', address, 'connection cap reached', ip);
    return json({ error: 'Too many requests' }, 429);
  }

  sseTokens.delete(sseToken); // single-use

  const ping = new TextEncoder().encode(`event: ping\ndata: {}\n\n`);
  let ctrl: ReadableStreamDefaultController;
  let interval: ReturnType<typeof setInterval> | undefined;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (interval !== undefined) clearInterval(interval);
    removeClient(address, ctrl);
    log('[sse]', address, 'disconnected');
  };

  const stream = new ReadableStream({
    start(c) {
      ctrl = c;
      addClient(address, ctrl);
      log('[sse]', address, 'connected');

      ctrl.enqueue(ping);

      interval = setInterval(() => {
        try {
          ctrl.enqueue(ping);
        } catch {
          error('[sse]', address, 'disconnected (heartbeat error)');
          cleanup();
        }
      }, 30_000);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...SECURITY_HEADERS,
    },
  });
}
