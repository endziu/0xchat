import { randomBytes } from 'node:crypto';
import { addClient, removeClient } from '../sse.ts';
import { json, getSessionAddress } from '../http.ts';
import { SECURITY_HEADERS, log, warn, error } from '../constants.ts';
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

export async function handleSSE({ url }: Context): Promise<Response> {
  const sseToken = url.searchParams.get('token');
  if (!sseToken) return json({ error: 'Missing token' }, 401);

  const tokenEntry = sseTokens.get(sseToken);
  if (!tokenEntry || tokenEntry.expiresAt < Date.now()) {
    sseTokens.delete(sseToken);
    return json({ error: 'Invalid or expired token' }, 401);
  }

  const address = tokenEntry.address;
  sseTokens.delete(sseToken); // single-use

  const stream = new ReadableStream({
    start(ctrl) {
      addClient(address, ctrl);
      log('[sse]', address, 'connected');

      ctrl.enqueue(new TextEncoder().encode(`event: ping\ndata: {}\n\n`));

      const interval = setInterval(() => {
        try {
          ctrl.enqueue(new TextEncoder().encode(`event: ping\ndata: {}\n\n`));
        } catch {
          error('[sse]', address, 'disconnected (heartbeat error)');
          clearInterval(interval);
          removeClient(address, ctrl);
        }
      }, 30_000);

      const origClose = ctrl.close.bind(ctrl);
      ctrl.close = () => {
        log('[sse]', address, 'disconnected');
        clearInterval(interval);
        removeClient(address, ctrl);
        origClose();
      };
    },
    cancel() {
      // cleanup handled via ctrl.close override above
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
