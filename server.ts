import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  createMessage,
  createSession,
  deleteExpiredMessages,
  deleteExpiredSessions,
  getConversationMessages,
  getConversations,
  getPubkey,
  getSession,
  initDb,
  registerPubkey,
  deleteAddressSessions,
  deleteAddressConversations,
  deleteAddress,
  getConversationPartners,
} from './src/server/db.ts';
import { isRateLimited } from './src/server/rate-limit.ts';
import { addClient, notify, removeClient } from './src/server/sse.ts';
import { verifySig } from './src/server/verify.ts';

const rawPort = Number(process.env['PORT'] ?? 3000);
if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
  throw new Error(`Invalid PORT: expected integer in [1, 65535], got ${process.env['PORT']}`);
}
const PORT = rawPort;

initDb();

// Periodic cleanup
setInterval(() => {
  deleteExpiredMessages();
  deleteExpiredSessions();
}, 30_000).unref();

const dir = import.meta.dir;
const distDir = join(dir, 'dist');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '),
} as const;

const VALID_TTLS = new Set([5, 10, 30, 60, 300, 1800, 3600, 21600, 86400]);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...SECURITY_HEADERS,
    },
  });
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(addr);
}

function isHex(s: string, byteLen?: number): boolean {
  const hex = s.startsWith('0x') ? s.slice(2) : s;
  if (byteLen !== undefined) {
    return hex.length === byteLen * 2 && /^[0-9a-f]+$/i.test(hex);
  }
  return hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-f]+$/i.test(hex);
}

function isValidSig(sig: string): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(sig);
}

function getSessionAddress(req: Request): string | null {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const session = getSession(token);
  return session?.address ?? null;
}

function getClientIp(
  req: Request,
  server: {
    requestIP: (req: Request) => { address: string } | null;
  },
): string {
  return server.requestIP(req)?.address ?? 'unknown';
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
}

// Challenge store for auth
const authChallenges = new Map<
  string,
  { challenge: string; address: string; expiresAt: number }
>();
// Track address → nonce for per-address challenge limits
const addressToChallengeNonce = new Map<string, string>();

// Challenge store for registration
const regChallenges = new Map<
  string,
  { challenge: string; address: string; expiresAt: number }
>();
// Track address → nonce for per-address registration challenge limits
const addressToRegNonce = new Map<string, string>();

// Single-use SSE tokens (30-second lifetime)
const sseTokens = new Map<string, { address: string; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of authChallenges) {
    if (val.expiresAt < now) {
      authChallenges.delete(key);
      addressToChallengeNonce.delete(val.address);
    }
  }
  for (const [key, val] of regChallenges) {
    if (val.expiresAt < now) {
      regChallenges.delete(key);
      addressToRegNonce.delete(val.address);
    }
  }
  for (const [key, val] of sseTokens) {
    if (val.expiresAt < now) {
      sseTokens.delete(key);
    }
  }
}, 60_000).unref();

const httpServer = Bun.serve({
  port: PORT,
  idleTimeout: 60, // 60 seconds
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const method = req.method;

    // HEAD support
    if (method === 'HEAD' && !path.startsWith('/api/')) {
      return new Response(null, { status: 200, headers: SECURITY_HEADERS });
    }

    // --- API Routes ---

    // POST /api/register/challenge
    if (method === 'POST' && path === '/api/register/challenge') {
      let body: { address?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const address = typeof body.address === 'string'
        ? body.address.trim().toLowerCase() : '';

      if (!isValidAddress(address)) {
        return json({ error: 'Invalid address' }, 400);
      }

      const nonce = randomBytes(16).toString('hex');
      const challenge = `ETH-Gate keypair v1\nAddress: ${address}\nNonce: ${nonce}`;

      // Replace existing challenge for this address (one per address)
      const oldNonce = addressToRegNonce.get(address);
      if (oldNonce) {
        regChallenges.delete(oldNonce);
      }

      addressToRegNonce.set(address, nonce);
      regChallenges.set(nonce, {
        challenge,
        address,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
      });

      return json({ challenge, nonce });
    }

    // POST /api/register
    if (method === 'POST' && path === '/api/register') {
      const ip = getClientIp(req, httpServer);
      if (isRateLimited(`${ip}:register`)) {
        console.log('[rate-limit] register', ip);
        return json({ error: 'Too many requests' }, 429);
      }

      let body: {
        address?: unknown; pubkey?: unknown; signature?: unknown; nonce?: unknown;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const address = typeof body.address === 'string'
        ? body.address.trim().toLowerCase() : '';
      let pubkey = typeof body.pubkey === 'string'
        ? body.pubkey.trim().toLowerCase() : '';
      if (pubkey.startsWith('0x')) pubkey = pubkey.slice(2);
      const signature = typeof body.signature === 'string' ? body.signature : '';
      const nonce = typeof body.nonce === 'string' ? body.nonce : '';

      if (!isValidAddress(address)) {
        return json({ error: 'invalid address' }, 400);
      }
      if (!isHex(pubkey, 33)) {
        return json(
          { error: 'pubkey must be 33-byte compressed hex' }, 400,
        );
      }
      if (!isValidSig(signature)) {
        return json({ error: 'invalid signature format' }, 400);
      }

      // Validate nonce and challenge
      const regChallenge = regChallenges.get(nonce);
      if (!regChallenge) {
        return json({ error: 'Invalid or expired challenge' }, 401);
      }
      if (regChallenge.address !== address) {
        return json({ error: 'Challenge address mismatch' }, 401);
      }

      const valid = await verifySig(regChallenge.challenge, signature, address);
      if (!valid) {
        return json({ error: 'signature verification failed' }, 401);
      }

      // Delete used nonce
      regChallenges.delete(nonce);
      addressToRegNonce.delete(address);

      registerPubkey(address, pubkey);
      console.log('[reg]', shortAddr(address), 'registered');
      return json({ ok: true });
    }

    // GET /api/pubkey/:address
    const pubkeyMatch = path.match(
      /^\/api\/pubkey\/(0x[0-9a-fA-F]{40})$/,
    );
    if (method === 'GET' && pubkeyMatch) {
      const address = pubkeyMatch[1]!.toLowerCase();
      const pubkey = getPubkey(address);
      return json({ pubkey: pubkey ? `0x${pubkey}` : null });
    }

    // POST /api/auth/challenge
    if (method === 'POST' && path === '/api/auth/challenge') {
      const ip = getClientIp(req, httpServer);
      if (isRateLimited(`${ip}:auth`)) {
        console.log('[rate-limit] auth-challenge', ip);
        return json({ error: 'Too many requests' }, 429);
      }

      let body: { address?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const address = typeof body.address === 'string'
        ? body.address.trim().toLowerCase() : '';
      if (!isValidAddress(address)) {
        return json({ error: 'invalid address' }, 400);
      }

      const nonce = randomBytes(16).toString('hex');
      const challenge = [
        'ETH-Chat session request',
        'Address: ' + address,
        'Nonce: ' + nonce,
      ].join('\n');

      // Replace any existing challenge for this address (1 outstanding per address)
      const oldNonce = addressToChallengeNonce.get(address);
      if (oldNonce) {
        authChallenges.delete(oldNonce);
      }

      authChallenges.set(nonce, {
        challenge,
        address,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      addressToChallengeNonce.set(address, nonce);

      return json({ challenge, nonce });
    }

    // POST /api/auth/session
    if (method === 'POST' && path === '/api/auth/session') {
      const ip = getClientIp(req, httpServer);
      if (isRateLimited(`${ip}:session`)) {
        console.log('[rate-limit] auth-session', ip);
        return json({ error: 'Too many requests' }, 429);
      }

      let body: {
        nonce?: unknown; signature?: unknown; address?: unknown;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const nonce = typeof body.nonce === 'string'
        ? body.nonce : '';
      const signature = typeof body.signature === 'string'
        ? body.signature : '';
      const address = typeof body.address === 'string'
        ? body.address.trim().toLowerCase() : '';

      if (!isValidAddress(address)) {
        return json({ error: 'invalid address' }, 400);
      }
      if (!isValidSig(signature)) {
        return json({ error: 'invalid signature format' }, 400);
      }

      const entry = authChallenges.get(nonce);
      if (!entry || entry.expiresAt < Date.now()) {
        authChallenges.delete(nonce);
        return json({ error: 'Challenge expired or not found' }, 401);
      }
      if (entry.address !== address) {
        return json({ error: 'Address mismatch' }, 401);
      }

      const valid = await verifySig(
        entry.challenge, signature, address,
      );
      if (!valid) {
        console.log('[auth] invalid sig', shortAddr(address));
        return json(
          { error: 'Signature verification failed' }, 401,
        );
      }

      authChallenges.delete(nonce);
      const token = randomBytes(32).toString('hex');
      const expiresAt = Date.now() + SESSION_TTL_MS;
      createSession(token, address, expiresAt);
      console.log('[auth]', shortAddr(address), 'session created');
      return json({ token, expires_at: expiresAt });
    }

    // --- Authenticated routes ---

    // POST /api/messages
    if (method === 'POST' && path === '/api/messages') {
      const sender = getSessionAddress(req);
      if (!sender) return json({ error: 'Unauthorized' }, 401);

      const ip = getClientIp(req, httpServer);
      if (isRateLimited(`${ip}:${sender}:msg`)) {
        console.log('[rate-limit] msg', shortAddr(sender), ip);
        return json({ error: 'Too many requests' }, 429);
      }

      let body: {
        recipient?: unknown;
        ct_recipient?: unknown;
        ephemeral_pub_recipient?: unknown;
        iv_recipient?: unknown;
        ct_sender?: unknown;
        ephemeral_pub_sender?: unknown;
        iv_sender?: unknown;
        ttl?: unknown;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const normalizeHex = (s: unknown) => {
        if (typeof s !== 'string') return '';
        const trimmed = s.trim().toLowerCase();
        return trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
      };

      const recipient = typeof body.recipient === 'string'
        ? body.recipient.trim().toLowerCase() : '';
      const ctRecipient = normalizeHex(body.ct_recipient);
      const ephPubRecipient = normalizeHex(body.ephemeral_pub_recipient);
      const ivRecipient = normalizeHex(body.iv_recipient);
      const ctSender = normalizeHex(body.ct_sender);
      const ephPubSender = normalizeHex(body.ephemeral_pub_sender);
      const ivSender = normalizeHex(body.iv_sender);
      const ttl = typeof body.ttl === 'number' ? body.ttl : 300;

      if (!isValidAddress(recipient)) {
        return json({ error: 'invalid recipient address' }, 400);
      }
      if (recipient === sender) {
        return json({ error: 'cannot message yourself' }, 400);
      }
      if (!VALID_TTLS.has(ttl)) {
        return json({ error: 'invalid TTL' }, 400);
      }
      if (
        !isHex(ctRecipient) || ctRecipient.length > 2_000_000
      ) {
        return json(
          { error: 'ct_recipient must be non-empty hex (max 1 MB)' },
          400,
        );
      }
      if (!isHex(ephPubRecipient, 33)) {
        return json(
          { error: 'ephemeral_pub_recipient must be 33-byte hex' },
          400,
        );
      }
      if (!isHex(ivRecipient, 12)) {
        return json(
          { error: 'iv_recipient must be 12-byte hex' }, 400,
        );
      }
      if (!isHex(ctSender) || ctSender.length > 2_000_000) {
        return json(
          { error: 'ct_sender must be non-empty hex (max 1 MB)' },
          400,
        );
      }
      if (!isHex(ephPubSender, 33)) {
        return json(
          { error: 'ephemeral_pub_sender must be 33-byte hex' }, 400,
        );
      }
      if (!isHex(ivSender, 12)) {
        return json(
          { error: 'iv_sender must be 12-byte hex' }, 400,
        );
      }

      if (!getPubkey(recipient)) {
        return json(
          { error: 'Recipient not registered' }, 400,
        );
      }

      const id = randomBytes(8).toString('hex');
      createMessage(
        id, sender, recipient,
        ctRecipient, ephPubRecipient, ivRecipient,
        ctSender, ephPubSender, ivSender,
        ttl,
      );

      const now = Date.now();
      const expiresAt = now + ttl * 1000;
      const event = {
        id, sender, recipient,
        ct_recipient: ctRecipient, ephemeral_pub_recipient: ephPubRecipient, iv_recipient: ivRecipient,
        ct_sender: ctSender, ephemeral_pub_sender: ephPubSender, iv_sender: ivSender,
        ttl, created_at: now, expires_at: expiresAt,
      };
      notify(recipient, 'message', event);
      notify(sender, 'message', event);

      console.log('[msg]', shortAddr(sender), '→', shortAddr(recipient), `ttl=${ttl}s`);
      return json({ id, created_at: now, expires_at: expiresAt }, 201);
    }

    // GET /api/messages/:address
    const msgsMatch = path.match(
      /^\/api\/messages\/(0x[0-9a-fA-F]{40})$/,
    );
    if (method === 'GET' && msgsMatch) {
      const address = getSessionAddress(req);
      if (!address) return json({ error: 'Unauthorized' }, 401);

      const counterparty = msgsMatch[1]!.toLowerCase();
      const beforeParam = url.searchParams.get('before');
      const beforeNum = beforeParam ? Number(beforeParam) : null;
      if (beforeParam != null && (!Number.isSafeInteger(beforeNum) || beforeNum <= 0)) {
        return json({ error: 'Invalid before parameter: must be a positive integer' }, 400);
      }
      const before = beforeNum && beforeNum > 0 ? beforeNum : undefined;
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam
        ? Math.min(Math.max(Number(limitParam), 1), 100)
        : 50;

      const msgs = getConversationMessages(
        address, counterparty, limit, before,
      );
      
      const prefixedMsgs = msgs.map(m => ({
        ...m,
        ct_recipient: `0x${m.ct_recipient}`,
        ephemeral_pub_recipient: `0x${m.ephemeral_pub_recipient}`,
        iv_recipient: `0x${m.iv_recipient}`,
        ct_sender: `0x${m.ct_sender}`,
        ephemeral_pub_sender: `0x${m.ephemeral_pub_sender}`,
        iv_sender: `0x${m.iv_sender}`,
      }));

      return json({ messages: prefixedMsgs });
    }

    // GET /api/conversations
    if (method === 'GET' && path === '/api/conversations') {
      const address = getSessionAddress(req);
      if (!address) return json({ error: 'Unauthorized' }, 401);

      const convs = getConversations(address);
      const mappedConvs = convs.map(c => ({
        address: c.counterparty,
        last_message_at: c.last_message_at,
      }));
      return json({ conversations: mappedConvs });
    }

    // DELETE /api/addresses/:addr
    const deleteAddrMatch = path.match(/^\/api\/addresses\/(.+)$/);
    if (method === 'DELETE' && deleteAddrMatch) {
      const address = getSessionAddress(req);
      if (!address) return json({ error: 'Unauthorized' }, 401);

      const targetAddr = deleteAddrMatch[1].toLowerCase();
      if (!isValidAddress(targetAddr)) return json({ error: 'Invalid address format' }, 400);
      if (address !== targetAddr) return json({ error: 'Forbidden' }, 403);

      // Get conversation partners before deleting
      const partners = getConversationPartners(address);

      // Clean up address data
      deleteAddressSessions(address);
      deleteAddressConversations(address);
      deleteAddress(address);

      // Notify conversation partners about the disconnection
      for (const partner of partners) {
        notify(partner, 'user:disconnected', { address });
      }

      console.log('[del]', shortAddr(address), 'deleted account, notified', partners.length, 'partners');
      return json({ success: true });
    }

    // POST /api/events/token — Get short-lived SSE token
    if (method === 'POST' && path === '/api/events/token') {
      const address = getSessionAddress(req);
      if (!address) return json({ error: 'Unauthorized' }, 401);

      const sseToken = randomBytes(16).toString('hex');
      sseTokens.set(sseToken, {
        address,
        expiresAt: Date.now() + 30_000, // 30 seconds
      });

      return json({ sse_token: sseToken });
    }

    // GET /api/events — SSE
    if (method === 'GET' && path === '/api/events') {
      const sseToken = url.searchParams.get('token');
      if (!sseToken) return json({ error: 'Missing token' }, 401);

      const tokenEntry = sseTokens.get(sseToken);
      if (!tokenEntry || tokenEntry.expiresAt < Date.now()) {
        sseTokens.delete(sseToken);
        return json({ error: 'Invalid or expired token' }, 401);
      }

      const address = tokenEntry.address;
      // Delete token after validation (single-use)
      sseTokens.delete(sseToken);

      const stream = new ReadableStream({
        start(ctrl) {
          addClient(address, ctrl);
          console.log('[sse]', shortAddr(address), 'connected');

          // Send initial ping
          const ping = `event: ping\ndata: {}\n\n`;
          ctrl.enqueue(new TextEncoder().encode(ping));

          // Heartbeat every 30s
          const interval = setInterval(() => {
            try {
              ctrl.enqueue(
                new TextEncoder().encode(
                  `event: ping\ndata: {}\n\n`,
                ),
              );
            } catch {
              console.log('[sse]', shortAddr(address), 'disconnected (heartbeat error)');
              clearInterval(interval);
              removeClient(address, ctrl);
            }
          }, 30_000);

          // Cleanup on cancel
          const origCancel = ctrl.close.bind(ctrl);
          ctrl.close = () => {
            console.log('[sse]', shortAddr(address), 'disconnected');
            clearInterval(interval);
            removeClient(address, ctrl);
            origCancel();
          };
        },
        cancel() {
          // cleanup happens via close override above
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

    // Static file serving from dist/
    if (method === 'GET') {
      // Use relative path for joining to avoid 'join' resetting to root
      const relativePath = path.startsWith('/') ? path.slice(1) : path;
      const resolved = join(distDir, relativePath);

      // Verify resolved path is within distDir
      const sep = '/';
      if (!resolved.startsWith(distDir + sep) && resolved !== distDir) {
        return json({ error: 'Not found' }, 404);
      }

      const file = Bun.file(resolved);

      if (await file.exists()) {
        return new Response(file, {
          headers: SECURITY_HEADERS,
        });
      }

      // SPA fallback to index.html (only for routes that don't look like files)
      if (!path.startsWith('/api/') && !path.includes('.')) {
        const indexFile = Bun.file(join(distDir, 'index.html'));
        if (await indexFile.exists()) {
          return new Response(indexFile, {
            headers: SECURITY_HEADERS,
          });
        }
      }
    }

    return json({ error: 'Not found' }, 404);
  },
  error(err: Error) {
    console.error('[error]', err.message);
    return json({ error: 'Internal server error' }, 500);
  },
});

console.log(`eth-chat server running on http://localhost:${PORT}`);
