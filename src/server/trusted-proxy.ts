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
 * Normalizes an IP address for comparison: trims, lowercases IPv6 hex, and
 * unwraps the `::ffff:` prefix of IPv4-mapped IPv6 addresses. Trust-list
 * entries and XFF hops are normalized the same way, so `::ffff:1.2.3.4`
 * matches a configured `1.2.3.4`.
 */
export function normalizeIp(raw: string): string {
  const ip = raw.trim().toLowerCase();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
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
  const normalizedPeer = normalizeIp(peer);
  if (!trusted.has(normalizedPeer)) return peer;
  const hops = (xff ?? '')
    .split(',')
    .map((hop) => normalizeIp(hop))
    .filter((hop) => hop !== '' && isIP(hop) !== 0);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    if (!trusted.has(hop)) return hop;
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
    ips.add(normalizeIp(ip));
  }
  return ips;
}

/** Trusted proxies for this process, from `TRUSTED_PROXY_IPS` (comma-separated IPs). */
export const TRUSTED_PROXY_IPS = parseTrustedProxyIps(process.env['TRUSTED_PROXY_IPS']);
