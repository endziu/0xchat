import { SECURITY_HEADERS } from './constants.ts';
import { getSession } from './db.ts';
import { TRUSTED_PROXY_IPS, resolveClientIp } from './trusted-proxy.ts';

export interface Context {
  req: Request;
  url: URL;
  path: string;
  method: string;
  ip: string;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...SECURITY_HEADERS,
    },
  });
}

export function getClientIp(
  req: Request,
  server: { requestIP: (req: Request) => { address: string } | null },
): string {
  const peer = server.requestIP(req)?.address ?? 'unknown';
  return resolveClientIp(peer, req.headers.get('x-forwarded-for'), TRUSTED_PROXY_IPS);
}

export function getSessionAddress(req: Request): string | null {
  const token = getBearerToken(req);
  if (!token) return null;
  const session = getSession(token);
  return session?.address ?? null;
}

export function getBearerToken(req: Request): string | null {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7) || null;
}
