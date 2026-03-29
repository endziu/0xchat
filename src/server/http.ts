import { SECURITY_HEADERS } from './constants.ts';
import { getSession } from './db.ts';

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
  return server.requestIP(req)?.address ?? 'unknown';
}

export function getSessionAddress(req: Request): string | null {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const session = getSession(auth.slice(7));
  return session?.address ?? null;
}
