import { join } from 'node:path';

const rawPort = Number(process.env['PORT'] ?? 3000);
if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
  throw new Error(`Invalid PORT: expected integer in [1, 65535], got ${process.env['PORT']}`);
}
export const PORT = rawPort;

export const DEBUG = process.env['DEBUG'] === '1' || process.env['DEBUG'] === 'true';

export function log(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}
export function error(...args: unknown[]): void {
  console.error(...args);
}
export function warn(...args: unknown[]): void {
  console.warn(...args);
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '),
} as const;

export const VALID_TTLS = new Set([5, 10, 30, 60, 300, 1800, 3600, 21600, 86400]);
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const distDir = join(import.meta.dir, '..', '..', 'dist');
