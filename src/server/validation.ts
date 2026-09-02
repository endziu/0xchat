import { verifyAddressBoundPublicKey } from '../shared/address-bound-pubkey.ts';

export function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(addr);
}

export function isValidSig(sig: string): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(sig);
}

export function normalizeAddressBoundPubkey(address: string, value: unknown): string | null {
  const result = verifyAddressBoundPublicKey(address, value);
  return result.ok ? result.publicKey : null;
}

function isBase64UrlOfLength(s: string, byteLen: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
  try {
    return Buffer.from(s, 'base64url').length === byteLen;
  } catch {
    return false;
  }
}

// Only these push services are allowed as subscription endpoints, to stop
// the server being used as an SSRF proxy against arbitrary hosts.
const ALLOWED_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
];

function isAllowedPushHost(hostname: string): boolean {
  return ALLOWED_PUSH_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

export interface ValidPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type PushSubscriptionValidationResult =
  | { ok: true; value: ValidPushSubscription }
  | { ok: false; reason: 'shape' | 'protocol' | 'p256dh' | 'auth' }
  | { ok: false; reason: 'host'; hostname: string };

export function validatePushSubscription(body: unknown): PushSubscriptionValidationResult {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'shape' };
  const candidate = body as Record<string, unknown>;
  if (typeof candidate['endpoint'] !== 'string' || candidate['endpoint'].length > 2000) {
    return { ok: false, reason: 'shape' };
  }

  let endpoint: URL;
  try {
    endpoint = new URL(candidate['endpoint']);
  } catch {
    return { ok: false, reason: 'shape' };
  }
  if (endpoint.protocol !== 'https:') return { ok: false, reason: 'protocol' };
  if (!isAllowedPushHost(endpoint.hostname)) {
    return { ok: false, reason: 'host', hostname: endpoint.hostname };
  }

  const keys = candidate['keys'];
  if (typeof keys !== 'object' || keys === null) return { ok: false, reason: 'shape' };
  const keyRecord = keys as Record<string, unknown>;
  if (
    typeof keyRecord['p256dh'] !== 'string'
    || !isBase64UrlOfLength(keyRecord['p256dh'], 65)
  ) {
    return { ok: false, reason: 'p256dh' };
  }
  if (typeof keyRecord['auth'] !== 'string' || !isBase64UrlOfLength(keyRecord['auth'], 16)) {
    return { ok: false, reason: 'auth' };
  }

  return {
    ok: true,
    value: {
      endpoint: candidate['endpoint'],
      keys: { p256dh: keyRecord['p256dh'], auth: keyRecord['auth'] },
    },
  };
}
