import { advertisesDeliveryCapability } from '../../shared/message-envelope.ts';
import { randomBytes } from 'node:crypto';
import { addClient, connectionCount, removeClient } from '../sse.ts';
import { json, getSessionAddress } from '../http.ts';
import { sseTokenLimiter } from '../rate-limiters.ts';
import { MAX_SSE_CONNECTIONS_PER_ADDRESS, SECURITY_HEADERS, log, warn, error } from '../constants.ts';
import type { Context } from '../http.ts';

/** Live long enough for the EventSource to dial in, short enough to bound reuse. */
const SSE_TOKEN_TTL_MS = 30_000;

interface SseTokenEntry {
  address: string;
  expiresAt: number;
  supportsOpening: boolean;
}

/**
 * Short-lived single-use tokens gating SSE streams.
 *
 * A token binds one authenticated address and expires after the TTL. It is
 * consumed only when a stream is actually admitted: a request rejected by
 * the per-address cap keeps its token, so the client's reconnect loop can
 * retry it once a slot frees. The clock is injectable so expiry is testable
 * without waiting out the TTL.
 */
export class SseTokenStore {
  private readonly tokens = new Map<string, SseTokenEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  mint(address: string, supportsOpening = false): string {
    const token = randomBytes(16).toString('hex');
    this.tokens.set(token, { address, expiresAt: this.now() + this.ttlMs, supportsOpening });
    return token;
  }

  /** Address bound to a live token, without consuming it. */
  lookup(token: string): string | null {
    const entry = this.tokens.get(token);
    if (!entry || entry.expiresAt < this.now()) {
      this.tokens.delete(token);
      return null;
    }
    return entry.address;
  }

  supportsOpening(token: string): boolean {
    return this.lookup(token) !== null && this.tokens.get(token)!.supportsOpening;
  }

  /** Consume a token (single-use); the bound address if live, else null. */
  consume(token: string): string | null {
    const address = this.lookup(token);
    if (address === null) return null;
    this.tokens.delete(token);
    return address;
  }

  /** Drop expired entries (periodic background sweep). */
  prune(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt < now) this.tokens.delete(token);
    }
  }
}

const sseTokenStore = new SseTokenStore(SSE_TOKEN_TTL_MS);

export function cleanupSseTokens(): void {
  sseTokenStore.prune();
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

  const sseToken = sseTokenStore.mint(address, advertisesDeliveryCapability(req.headers));

  log('[sse-token]', address);
  return json({ sse_token: sseToken });
}

export async function handleSSE({ url, ip }: Context): Promise<Response> {
  const sseToken = url.searchParams.get('token');
  if (!sseToken) return json({ error: 'Missing token' }, 401);

  const address = sseTokenStore.lookup(sseToken);
  if (!address) {
    return json({ error: 'Invalid or expired token' }, 401);
  }

  // Checked before the token is consumed: a rejected client keeps its token
  // and can retry it once a slot frees (the client's reconnect loop re-dials).
  if (connectionCount(address) >= MAX_SSE_CONNECTIONS_PER_ADDRESS) {
    warn('[sse]', address, 'connection cap reached', ip);
    return json({ error: 'Too many requests' }, 429);
  }

  const supportsOpening = sseTokenStore.supportsOpening(sseToken);
  sseTokenStore.consume(sseToken); // single-use

  const ping = new TextEncoder().encode(`event: ping\ndata: {}\n\n`);
  let controller: ReadableStreamDefaultController;
  let interval: ReturnType<typeof setInterval> | undefined;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (interval !== undefined) clearInterval(interval);
    removeClient(address, controller);
    log('[sse]', address, 'disconnected');
  };

  const stream = new ReadableStream({
    start(streamController) {
      controller = streamController;
      addClient(address, controller, supportsOpening);
      log('[sse]', address, 'connected');

      controller.enqueue(ping);

      interval = setInterval(() => {
        try {
          controller.enqueue(ping);
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
