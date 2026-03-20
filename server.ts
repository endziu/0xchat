import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
} from './src/server/db.ts';
import { isRateLimited } from './src/server/rate-limit.ts';
import { addClient, notify, removeClient } from './src/server/sse.ts';
import { verifySig } from './src/server/verify.ts';

const PORT = Number(process.env['PORT'] ?? 3000);
const rawProjectId = process.env['WALLETCONNECT_PROJECT_ID'];
if (!rawProjectId) {
  throw new Error(
    'WALLETCONNECT_PROJECT_ID env var is required.',
  );
}
const projectId: string = rawProjectId;

initDb();

// Periodic cleanup
setInterval(() => {
  deleteExpiredMessages();
  deleteExpiredSessions();
}, 30_000).unref();

const dir = import.meta.dir;
const rawChatHtml = readFileSync(
  join(dir, 'src/server/views/chat.html'), 'utf-8',
);
const rawRegisterHtml = readFileSync(
  join(dir, 'src/server/views/register.html'), 'utf-8',
);
const chatCryptoJs = readFileSync(
  join(dir, 'src/server/chat-crypto.js'), 'utf-8',
);
const chatSessionJs = readFileSync(
  join(dir, 'src/server/chat-session.js'), 'utf-8',
);
const chatClientJs = readFileSync(
  join(dir, 'src/server/chat-client.js'), 'utf-8',
);
const secp256k1Js = readFileSync(
  join(dir, 'src/server/secp256k1.bundle.js'), 'utf-8',
);
const walletJs = readFileSync(
  join(dir, 'src/server/wallet.bundle.js'), 'utf-8',
);
const utilsJs = readFileSync(
  join(dir, 'src/server/utils.js'), 'utf-8',
);

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'nonce-__CSP_NONCE__' 'sha256-NzvNrqk5jB9YZATwo5BF4JoRlJ02HsnFikbKXgEPdaQ='",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com https://fonts.reown.com",
  "connect-src 'self' https://api.web3modal.org https://rpc.walletconnect.org https://pulse.walletconnect.org https://echo.walletconnect.com https://verify.walletconnect.com https://verify.walletconnect.org https://secure.walletconnect.org https://secure-mobile.walletconnect.com https://secure-mobile.walletconnect.org wss://relay.walletconnect.org",
  'frame-src https://secure.walletconnect.org https://secure-mobile.walletconnect.com https://secure-mobile.walletconnect.org',
  "img-src 'self' https://api.web3modal.org data: blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

const KEYPAIR_MSG = 'ETH-Gate keypair v1';
const VALID_TTLS = new Set([30, 300, 3600, 86400]);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function injectTemplate(
  template: string, nonce: string,
): string {
  return template
    .replace('__WC_PROJECT_ID__', projectId)
    .replaceAll('__CSP_NONCE__', nonce);
}

function htmlResponse(template: string): Response {
  const nonce = randomUUID();
  return new Response(injectTemplate(template, nonce), {
    headers: {
      'Content-Type': 'text/html',
      'Content-Security-Policy': CSP.replace('__CSP_NONCE__', nonce),
      ...SECURITY_HEADERS,
    },
  });
}

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
  if (byteLen !== undefined) {
    return s.length === byteLen * 2 && /^[0-9a-f]+$/.test(s);
  }
  return s.length > 0 && s.length % 2 === 0 && /^[0-9a-f]+$/.test(s);
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

// Challenge store for auth (in-memory, short-lived)
const authChallenges = new Map<
  string,
  { challenge: string; address: string; expiresAt: number }
>();

// Cleanup auth challenges periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of authChallenges) {
    if (val.expiresAt < now) authChallenges.delete(key);
  }
}, 60_000).unref();

const JS_FILES: Record<string, string> = {
  '/chat-crypto.js': chatCryptoJs,
  '/chat-session.js': chatSessionJs,
  '/chat-client.js': chatClientJs,
  '/secp256k1.js': secp256k1Js,
  '/wallet.js': walletJs,
  '/utils.js': utilsJs,
};

const httpServer = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const method = req.method;

    // HEAD support for COOP check
    if (method === 'HEAD' && (
      path === '/' || path === '/chat' || path === '/register'
      || /^\/chat\/0x[0-9a-fA-F]{40}$/.test(path)
    )) {
      return new Response(null, {
        status: 200,
        headers: SECURITY_HEADERS,
      });
    }

    // GET / → redirect to /chat
    if (method === 'GET' && path === '/') {
      return Response.redirect('/chat', 302);
    }

    // GET /register
    if (method === 'GET' && path === '/register') {
      return htmlResponse(rawRegisterHtml);
    }

    // GET /chat or /chat/:address
    if (method === 'GET' && (
      path === '/chat'
      || /^\/chat\/0x[0-9a-fA-F]{40}$/.test(path)
    )) {
      return htmlResponse(rawChatHtml);
    }

    // Static JS files
    const jsContent = JS_FILES[path];
    if (method === 'GET' && jsContent !== undefined) {
      return new Response(jsContent, {
        headers: {
          'Content-Type': 'application/javascript',
          ...SECURITY_HEADERS,
        },
      });
    }

    // POST /api/register
    if (method === 'POST' && path === '/api/register') {
      const ip = getClientIp(req, httpServer);
      if (isRateLimited(`${ip}:register`)) {
        return json({ error: 'Too many requests' }, 429);
      }

      let body: {
        address?: unknown; pubkey?: unknown; sig?: unknown;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const address = typeof body.address === 'string'
        ? body.address.trim().toLowerCase() : '';
      const pubkey = typeof body.pubkey === 'string'
        ? body.pubkey.trim().toLowerCase() : '';
      const sig = typeof body.sig === 'string' ? body.sig : '';

      if (!isValidAddress(address)) {
        return json({ error: 'invalid address' }, 400);
      }
      if (!isHex(pubkey, 33)) {
        return json(
          { error: 'pubkey must be 33-byte compressed hex' }, 400,
        );
      }
      if (!isValidSig(sig)) {
        return json({ error: 'invalid signature format' }, 400);
      }

      const valid = await verifySig(KEYPAIR_MSG, sig, address);
      if (!valid) {
        return json({ error: 'signature verification failed' }, 401);
      }

      registerPubkey(address, pubkey);
      return json({ ok: true });
    }

    // GET /api/pubkey/:address
    const pubkeyMatch = path.match(
      /^\/api\/pubkey\/(0x[0-9a-fA-F]{40})$/,
    );
    if (method === 'GET' && pubkeyMatch) {
      const address = pubkeyMatch[1]!.toLowerCase();
      const pubkey = getPubkey(address);
      if (!pubkey) return json({ error: 'Not registered' }, 404);
      return json({ pubkey });
    }

    // POST /api/auth/challenge
    if (method === 'POST' && path === '/api/auth/challenge') {
      const ip = getClientIp(req, httpServer);
      if (isRateLimited(`${ip}:auth`)) {
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

      authChallenges.set(nonce, {
        challenge,
        address,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      return json({ challenge, nonce });
    }

    // POST /api/auth/session
    if (method === 'POST' && path === '/api/auth/session') {
      const ip = getClientIp(req, httpServer);
      if (isRateLimited(`${ip}:session`)) {
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
        return json(
          { error: 'Signature verification failed' }, 401,
        );
      }

      authChallenges.delete(nonce);
      const token = randomBytes(32).toString('hex');
      const expiresAt = Date.now() + SESSION_TTL_MS;
      createSession(token, address, expiresAt);
      return json({ token, expires_at: expiresAt });
    }

    // --- Authenticated routes ---

    // POST /api/messages
    if (method === 'POST' && path === '/api/messages') {
      const sender = getSessionAddress(req);
      if (!sender) return json({ error: 'Unauthorized' }, 401);

      const ip = getClientIp(req, httpServer);
      if (isRateLimited(`${ip}:msg`)) {
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

      const recipient = typeof body.recipient === 'string'
        ? body.recipient.trim().toLowerCase() : '';
      const ctRecipient = typeof body.ct_recipient === 'string'
        ? body.ct_recipient.toLowerCase() : '';
      const ephPubRecipient =
        typeof body.ephemeral_pub_recipient === 'string'
          ? body.ephemeral_pub_recipient.toLowerCase() : '';
      const ivRecipient = typeof body.iv_recipient === 'string'
        ? body.iv_recipient.toLowerCase() : '';
      const ctSender = typeof body.ct_sender === 'string'
        ? body.ct_sender.toLowerCase() : '';
      const ephPubSender =
        typeof body.ephemeral_pub_sender === 'string'
          ? body.ephemeral_pub_sender.toLowerCase() : '';
      const ivSender = typeof body.iv_sender === 'string'
        ? body.iv_sender.toLowerCase() : '';
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
        id, sender, created_at: now, expires_at: expiresAt,
      };
      notify(recipient, 'message', event);
      notify(sender, 'message', event);

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
      const before = beforeParam ? Number(beforeParam) : undefined;
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam
        ? Math.min(Math.max(Number(limitParam), 1), 100)
        : 50;

      const msgs = getConversationMessages(
        address, counterparty, limit, before,
      );
      return json({ messages: msgs });
    }

    // GET /api/conversations
    if (method === 'GET' && path === '/api/conversations') {
      const address = getSessionAddress(req);
      if (!address) return json({ error: 'Unauthorized' }, 401);

      const convs = getConversations(address);
      return json({ conversations: convs });
    }

    // GET /api/events — SSE
    if (method === 'GET' && path === '/api/events') {
      const token = url.searchParams.get('token');
      if (!token) return json({ error: 'Missing token' }, 401);

      const session = getSession(token);
      if (!session) return json({ error: 'Invalid token' }, 401);
      const address = session.address;

      const stream = new ReadableStream({
        start(ctrl) {
          addClient(address, ctrl);

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
              clearInterval(interval);
              removeClient(address, ctrl);
            }
          }, 30_000);

          // Cleanup on cancel
          const origCancel = ctrl.close.bind(ctrl);
          ctrl.close = () => {
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

    return json({ error: 'Not found' }, 404);
  },
});

console.log(`eth-chat server running on http://localhost:${PORT}`);
