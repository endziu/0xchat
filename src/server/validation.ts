export function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(addr);
}

export function isHex(s: string, byteLen?: number): boolean {
  const hex = s.startsWith('0x') ? s.slice(2) : s;
  if (byteLen !== undefined) {
    return hex.length === byteLen * 2 && /^[0-9a-f]+$/i.test(hex);
  }
  return hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-f]+$/i.test(hex);
}

export function isValidSig(sig: string): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(sig);
}

export function normalizeHex(s: unknown): string {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim().toLowerCase();
  return trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
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
];

function isAllowedPushHost(hostname: string): boolean {
  return ALLOWED_PUSH_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

export function isValidPushSubscription(
  body: unknown,
): body is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b['endpoint'] !== 'string' || b['endpoint'].length > 2000) return false;
  try {
    const url = new URL(b['endpoint']);
    if (url.protocol !== 'https:' || !isAllowedPushHost(url.hostname)) return false;
  } catch {
    return false;
  }
  const keys = b['keys'];
  if (typeof keys !== 'object' || keys === null) return false;
  const k = keys as Record<string, unknown>;
  if (typeof k['p256dh'] !== 'string' || !isBase64UrlOfLength(k['p256dh'], 65)) return false;
  if (typeof k['auth'] !== 'string' || !isBase64UrlOfLength(k['auth'], 16)) return false;
  return true;
}
