import { isIP } from 'node:net';

/**
 * Client IP resolution behind reverse proxies.
 *
 * `X-Forwarded-For` is only consulted when the direct peer (the socket
 * address the server saw) is an explicitly configured trusted proxy.
 * Without that gate the header is attacker-controlled noise, so it is
 * ignored entirely.
 */

/**
 * Light cleanup for an IP address used in returned values: trims and
 * lowercases only. It must never rewrite a valid address form — mapped
 * spellings like `::ffff:c633:6402` stay valid so XFF hops are not discarded
 * — trust-set comparisons use {@link canonicalIp} instead, where equivalent
 * spellings converge.
 */
export function normalizeIp(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Canonical equality form for an IP address: IPv4 as-is, IPv6 as eight
 * zero-padded hex groups, and IPv4-mapped IPv6 (dotted or hex tail) unwrapped
 * to dotted quad. Equivalent spellings compare equal: `2001:db8::1`,
 * `2001:0db8:0:0:0:0:0:1`, and `2001:DB8::1` all canonicalize the same, and
 * `::ffff:1.2.3.4` canonicalizes to `1.2.3.4`. Used only for trust-set
 * lookups, never for the IP returned to callers. Non-IP input passes through
 * trimmed and lowercased, so lookups miss without crashing.
 */
export function canonicalIp(raw: string): string {
  const ip = raw.trim().toLowerCase();
  const kind = isIP(ip);
  if (kind !== 6) return ip;
  let s = ip;
  const dot = s.indexOf('.');
  if (dot !== -1) {
    const colon = s.lastIndexOf(':');
    const [a, b, c, d] = s.slice(colon + 1).split('.').map(Number);
    s = `${s.slice(0, colon + 1)}${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
  }
  let left: string[];
  let right: string[];
  if (s.includes('::')) {
    const [l, r] = s.split('::');
    left = l ? l.split(':') : [];
    right = r ? r.split(':') : [];
  } else {
    left = s.split(':');
    right = [];
  }
  const groups = [
    ...left,
    ...Array<string>(8 - left.length - right.length).fill('0'),
    ...right,
  ].map((g) => g.padStart(4, '0'));
  if (groups.slice(0, 5).every((g) => g === '0000') && groups[5] === 'ffff') {
    const hi = Number.parseInt(groups[6]!, 16);
    const lo = Number.parseInt(groups[7]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return groups.join(':');
}

/**
 * Resolves the client IP for a request.
 *
 * - No trusted proxies configured: returns `peer` unchanged.
 * - `peer` not in `trusted`: returns `peer` unchanged (spoofed XFF ignored).
 * - `peer` trusted: walks `xff` right-to-left and returns the first hop
 *   that is not itself a trusted proxy; an all-trusted chain yields the
 *   leftmost hop; a missing/empty header yields `peer`. Hops that are not
 *   valid IP addresses are dropped — a garbage entry must never become the
 *   client identity for rate limiting.
 */
export function resolveClientIp(
  peer: string,
  xff: string | null,
  trusted: ReadonlySet<string>,
): string {
  if (!trusted.has(canonicalIp(peer))) return peer;
  const hops = (xff ?? '')
    .split(',')
    .map((hop) => normalizeIp(hop))
    .filter((hop) => hop !== '' && isIP(hop) !== 0);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    if (!trusted.has(canonicalIp(hop))) return hop;
  }
  return hops.length > 0 ? hops[0]! : peer;
}

/**
 * Parses the `TRUSTED_PROXY_IPS` env value into a normalized trust set.
 * Unset or blank yields an empty set — the feature is off and
 * `X-Forwarded-For` is never consulted. Malformed entries throw at startup
 * (fail fast, like `PORT`): a broken config must not silently disable the
 * trusted-proxy gate or accept a wrong proxy set.
 */
export function parseTrustedProxyIps(raw: string | undefined): ReadonlySet<string> {
  const ips = new Set<string>();
  for (const entry of raw?.split(',') ?? []) {
    const ip = entry.trim();
    if (ip === '') continue;
    if (isIP(ip) === 0) {
      throw new Error(`Invalid TRUSTED_PROXY_IPS entry: ${ip}`);
    }
    ips.add(canonicalIp(ip));
  }
  return ips;
}

/** Trusted proxies for this process, from `TRUSTED_PROXY_IPS` (comma-separated IPs). */
export const TRUSTED_PROXY_IPS = parseTrustedProxyIps(process.env['TRUSTED_PROXY_IPS']);
