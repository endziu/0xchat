import { getClientIp } from './http.ts';
import { SECURITY_HEADERS, log } from './constants.ts';
import { handleRegisterChallenge, handleRegister, regStore } from './routes/register.ts';
import { handleAuthChallenge, handleAuthSession, authStore } from './routes/auth.ts';
import { handleGetPubkey } from './routes/pubkey.ts';
import { handleSendMessage, handleGetMessages, handleGetConversations } from './routes/messages.ts';
import { handleGetSSEToken, handleSSE, cleanupSseTokens } from './routes/events.ts';
import { handleDeleteAddress } from './routes/account.ts';
import { handleStatic } from './routes/static.ts';
import type { Context } from './http.ts';

export { regStore, authStore, cleanupSseTokens };

type Handler = (ctx: Context) => Promise<Response>;

interface Route {
  method: string;
  test: (path: string) => boolean;
  handler: Handler;
}

const routes: Route[] = [
  { method: 'POST',   test: eq('/api/register/challenge'),              handler: handleRegisterChallenge },
  { method: 'POST',   test: eq('/api/register'),                        handler: handleRegister },
  { method: 'GET',    test: re(/^\/api\/pubkey\/0x[0-9a-fA-F]{40}$/),   handler: handleGetPubkey },
  { method: 'POST',   test: eq('/api/auth/challenge'),                  handler: handleAuthChallenge },
  { method: 'POST',   test: eq('/api/auth/session'),                    handler: handleAuthSession },
  { method: 'POST',   test: eq('/api/messages'),                        handler: handleSendMessage },
  { method: 'GET',    test: re(/^\/api\/messages\/0x[0-9a-fA-F]{40}$/), handler: handleGetMessages },
  { method: 'GET',    test: eq('/api/conversations'),                   handler: handleGetConversations },
  { method: 'DELETE', test: re(/^\/api\/addresses\/.+$/),               handler: handleDeleteAddress },
  { method: 'POST',   test: eq('/api/events/token'),                    handler: handleGetSSEToken },
  { method: 'GET',    test: eq('/api/events'),                          handler: handleSSE },
  { method: 'GET',    test: () => true,                                 handler: handleStatic },
];

function eq(expected: string) {
  return (path: string) => path === expected;
}
function re(pattern: RegExp) {
  return (path: string) => pattern.test(path);
}

export function createFetch() {
  return async (req: Request, server: { requestIP: (r: Request) => { address: string } | null }): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const { method } = req;
    const ip = getClientIp(req, server);

    log(`[req] ${method} ${path} [${ip}]`);

    if (method === 'HEAD' && !path.startsWith('/api/')) {
      return new Response(null, { status: 200, headers: SECURITY_HEADERS });
    }

    const ctx: Context = { req, url, path, method, ip };
    const route = routes.find((r) => r.method === method && r.test(path));
    return route ? route.handler(ctx) : notFound();
  };
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS },
  });
}
