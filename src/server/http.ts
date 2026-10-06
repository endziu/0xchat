import type { Address } from '../shared/address.ts';
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

/** Count actual streamed bytes, never trusting Content-Length. */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) return json({ error: 'Invalid JSON' }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Cancellation must not delay rejection or turn it into a parse error.
        void reader.cancel().catch(() => {});
        return json({ error: 'Request body too large' }, 413);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  } finally {
    reader.releaseLock();
  }
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
