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
 * Canonical form of an IP address, used both as the trust-set key and as the
 * client identity the resolver returns: IPv4 as-is, IPv4-mapped IPv6 (dotted
 * or hex tail) unwrapped to dotted quad, and pure IPv6 in RFC 5952 compressed
 * form. Equivalent spellings converge: `2001:db8::1`, `2001:0db8:0:0:0:0:0:1`,
 * and `2001:DB8::1` all canonicalize to `2001:db8::1`, and
 * `::ffff:1.2.3.4` / `::ffff:c000:201` to `1.2.3.4` — so one client can never
 * split across rate-limit buckets because an edge serialized it differently.
 * Scoped IPv6 input is kept opaque: zone identifiers are host-local and must
 * never be discarded into the same trust key as another interface. Non-IP
 * input passes through trimmed and lowercased, so lookups miss without crashing.
 */
export function canonicalIp(raw: string): string {
  const ip = raw.trim().toLowerCase();
  if (ip.includes('%')) return ip;
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
  ].map((g) => Number.parseInt(g, 16).toString(16));
  if (groups.slice(0, 5).every((g) => g === '0') && groups[5] === 'ffff') {
    const hi = Number.parseInt(groups[6]!, 16);
    const lo = Number.parseInt(groups[7]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  // RFC 5952: compress the longest run of zero groups (leftmost on ties);
  // runs of a single group stay expanded.
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === '0') {
      if (runStart === -1) runStart = i;
      if (i - runStart + 1 > bestLen) {
        bestLen = i - runStart + 1;
        bestStart = runStart;
      }
    } else {
      runStart = -1;
    }
  }
  if (bestLen >= 2) {
    return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLen).join(':')}`;
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
    .map((hop) => hop.trim().toLowerCase())
    .filter((hop) => hop !== '' && !hop.includes('%') && isIP(hop) !== 0);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = canonicalIp(hops[i]!);
    if (!trusted.has(hop)) return hop;
  }
  return hops.length > 0 ? canonicalIp(hops[0]!) : canonicalIp(peer);
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
    if (ip.includes('%')) {
      throw new Error(`Scoped IPv6 addresses are not supported in TRUSTED_PROXY_IPS: ${ip}`);
    }
    if (isIP(ip) === 0) {
      throw new Error(`Invalid TRUSTED_PROXY_IPS entry: ${ip}`);
    }
    ips.add(canonicalIp(ip));
  }
  return ips;
}

/** Trusted proxies for this process, from `TRUSTED_PROXY_IPS` (comma-separated IPs). */
export const TRUSTED_PROXY_IPS = parseTrustedProxyIps(process.env['TRUSTED_PROXY_IPS']);
