import { parseAddress } from '../shared/address'
import { getClientIp } from './http.ts';
import { SECURITY_HEADERS, log } from './constants.ts';
import { TRUSTED_PROXY_IPS } from './trusted-proxy.ts';
import { handleRegisterChallenge, handleRegister, regStore } from './routes/register.ts';
import { handleAuthChallenge, handleAuthSession, authStore } from './routes/auth.ts';
import { handleGetPubkey } from './routes/pubkey.ts';
import { handleClearConversation, handleMessageStates, handleRecoverMessages, handleOpenMessages, handleSendMessage, handleGetMessages, handleGetConversations } from './routes/messages.ts';
import { handleGetSSEToken, handleSSE, handleSSEAttention, cleanupSseTokens } from './routes/events.ts';
import { handleGetVapidPublicKey, handleSubscribePush, handleUnsubscribePush } from './routes/push.ts';
import { handleDeleteAddress } from './routes/account.ts';
import { handleDeleteSession } from './routes/session.ts';
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
  { method: 'GET',    test: addressRoute('/api/pubkey/'),   handler: handleGetPubkey },
  { method: 'POST',   test: eq('/api/auth/challenge'),                  handler: handleAuthChallenge },
  { method: 'POST',   test: eq('/api/auth/session'),                    handler: handleAuthSession },
  { method: 'DELETE', test: eq('/api/session'),                         handler: handleDeleteSession },
  { method: 'POST',   test: addressRoute('/api/messages/', '/open'), handler: handleOpenMessages },
  { method: 'GET',    test: addressRoute('/api/messages/', '/recover'), handler: handleRecoverMessages },
  { method: 'POST',   test: addressRoute('/api/messages/', '/state'), handler: handleMessageStates },
  { method: 'POST',   test: eq('/api/messages'),                        handler: handleSendMessage },
  { method: 'GET',    test: addressRoute('/api/messages/'), handler: handleGetMessages },
  { method: 'DELETE', test: addressRoute('/api/messages/'), handler: handleClearConversation },
  { method: 'GET',    test: eq('/api/conversations'),                   handler: handleGetConversations },
  { method: 'DELETE', test: re(/^\/api\/addresses\/.+$/),               handler: handleDeleteAddress },
  { method: 'POST',   test: eq('/api/events/token'),                    handler: handleGetSSEToken },
  { method: 'GET',    test: eq('/api/events'),                          handler: handleSSE },
  { method: 'POST',   test: eq('/api/events/attention'),                handler: handleSSEAttention },
  { method: 'GET',    test: eq('/api/push/vapid-public-key'),           handler: handleGetVapidPublicKey },
  { method: 'POST',   test: eq('/api/push/subscribe'),                  handler: handleSubscribePush },
  { method: 'POST',   test: eq('/api/push/unsubscribe'),                handler: handleUnsubscribePush },
  { method: 'GET',    test: () => true,                                 handler: handleStatic },
];

function addressRoute(prefix: string, suffix = '') {
  return (path: string) => path.startsWith(prefix) && path.endsWith(suffix)
    && parseAddress(path.slice(prefix.length, suffix ? -suffix.length : undefined)) !== null;
}

function eq(expected: string) {
  return (path: string) => path === expected;
}
function re(pattern: RegExp) {
  return (path: string) => pattern.test(path);
}

export function createFetch(options: { trustedProxies?: ReadonlySet<string> } = {}) {
  const trustedProxies = options.trustedProxies ?? TRUSTED_PROXY_IPS;
  return async (req: Request, server: { requestIP: (r: Request) => { address: string } | null }): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const { method } = req;
    const ip = getClientIp(req, server, trustedProxies);

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
