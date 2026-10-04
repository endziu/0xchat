import type { Address } from '../shared/address'
import { SECURITY_HEADERS } from './constants.ts';
import { getSession } from './db.ts';
import { resolveClientIp } from './trusted-proxy.ts';
import { advertisesDeliveryCapability } from '../shared/message-envelope.ts';

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

/** Clients that cannot interpret recipient opening must update before using messages. */
export function isOutdatedClient(req: Request): boolean {
  return !advertisesDeliveryCapability(req.headers);
}

export function clientUpdateRequired(): Response {
  return json({ error: 'This 0xChat client is out of date. Reload the page or update the CLI.', code: 'client_update_required' }, 426);
}

export function getClientIp(
  req: Request,
  server: { requestIP: (req: Request) => { address: string } | null },
  trustedProxies: ReadonlySet<string>,
): string {
  const peer = server.requestIP(req)?.address ?? 'unknown';
  return resolveClientIp(peer, req.headers.get('x-forwarded-for'), trustedProxies);
}

export function getSessionAddress(req: Request): Address | null {
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
