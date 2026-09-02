import { describe, expect, test } from 'bun:test';
import { parseTrustedProxyIps, resolveClientIp } from './trusted-proxy.ts';

describe('resolveClientIp', () => {
  test('with no trusted proxies configured, returns the peer IP and ignores X-Forwarded-For', () => {
    const none = new Set<string>();
    expect(resolveClientIp('203.0.113.50', '198.51.100.1, 203.0.113.50', none)).toBe('203.0.113.50');
    expect(resolveClientIp('203.0.113.50', null, none)).toBe('203.0.113.50');
  });

  test('with a trusted peer, returns the rightmost hop that is not itself a trusted proxy', () => {
    const trusted = new Set(['198.51.100.1', '198.51.100.2']);
    // client, edge proxy, lb — lb is the socket peer
    expect(
      resolveClientIp('198.51.100.2', '203.0.113.7, 198.51.100.1, 198.51.100.2', trusted),
    ).toBe('203.0.113.7');
    expect(resolveClientIp('198.51.100.2', '203.0.113.7', trusted)).toBe('203.0.113.7');
  });

  test('ignores a spoofed X-Forwarded-For when the direct peer is not a trusted proxy', () => {
    const trusted = new Set(['198.51.100.1']);
    // Attacker connects directly and injects XFF to fake other clients.
    expect(resolveClientIp('203.0.113.66', '198.51.100.99, 198.51.100.1', trusted)).toBe('203.0.113.66');
    expect(resolveClientIp('203.0.113.66', null, trusted)).toBe('203.0.113.66');
  });

  test('matches IPv4-mapped IPv6 peers against plain IPv4 trust entries', () => {
    const trusted = new Set(['198.51.100.1']);
    expect(resolveClientIp('::ffff:198.51.100.1', '203.0.113.7', trusted)).toBe('203.0.113.7');
  });

  test('compares IPv6 addresses case-insensitively', () => {
    const trusted = new Set(['2001:db8::1']);
    expect(resolveClientIp('2001:DB8::1', '203.0.113.7', trusted)).toBe('203.0.113.7');
  });

  test('a trusted peer without X-Forwarded-For keeps the peer IP', () => {
    const trusted = new Set(['198.51.100.1']);
    expect(resolveClientIp('198.51.100.1', null, trusted)).toBe('198.51.100.1');
    expect(resolveClientIp('198.51.100.1', '  ', trusted)).toBe('198.51.100.1');
  });

  test('an all-trusted chain falls back to the leftmost hop', () => {
    const trusted = new Set(['198.51.100.1', '198.51.100.2', '198.51.100.3']);
    expect(
      resolveClientIp('198.51.100.3', '198.51.100.1, 198.51.100.2', trusted),
    ).toBe('198.51.100.1');
  });

  test('non-IP garbage in the chain is never returned as the client', () => {
    const trusted = new Set(['198.51.100.1']);
    expect(resolveClientIp('198.51.100.1', 'attacker.example, 203.0.113.7', trusted)).toBe('203.0.113.7');
    expect(resolveClientIp('198.51.100.1', 'attacker.example', trusted)).toBe('198.51.100.1');
  });
});

describe('parseTrustedProxyIps', () => {
  test('unset or blank env yields an empty trust list', () => {
    expect(parseTrustedProxyIps(undefined).size).toBe(0);
    expect(parseTrustedProxyIps('').size).toBe(0);
    expect(parseTrustedProxyIps(' , ,').size).toBe(0);
  });

  test('parses a comma-separated list, trimming and normalizing entries', () => {
    const ips = parseTrustedProxyIps(' 198.51.100.1, ::ffff:198.51.100.2 , 2001:DB8::1 ');
    expect(ips.has('198.51.100.1')).toBe(true);
    expect(ips.has('198.51.100.2')).toBe(true);
    expect(ips.has('2001:db8::1')).toBe(true);
    expect(ips.size).toBe(3);
  });

  test('rejects malformed entries at startup', () => {
    expect(() => parseTrustedProxyIps('198.51.100.1, 999.0.0.1')).toThrow(/999\.0\.0\.1/);
    expect(() => parseTrustedProxyIps('localhost')).toThrow(/localhost/);
  });
});
