import { createHmac, timingSafeEqual } from 'node:crypto';
import { recoveryMetadata } from './db.ts';

interface RecoveryCursor {
  version: 1;
  address: string;
  counterparty: string;
  lower: number;
  upper: number | null;
}

// A persisted key keeps cursors valid after restart, without storing a growing token log.
export function issueRecoveryCursor(address: string, counterparty: string, lower: number, upper: number | null = null): string {
  const payload: RecoveryCursor = { version: 1, address, counterparty, lower, upper };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', recoveryMetadata().cursor_key).update(encoded).digest('base64url');
  return `${encoded}.${mac}`;
}

export function readRecoveryCursor(token: string, address: string, counterparty: string): RecoveryCursor | null {
  if (token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts as [string, string];
  const expected = createHmac('sha256', recoveryMetadata().cursor_key).update(encoded).digest('base64url');
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as RecoveryCursor;
    if (cursor.version !== 1 || cursor.address !== address || cursor.counterparty !== counterparty
      || !Number.isSafeInteger(cursor.lower) || cursor.lower < 0
      || (cursor.upper !== null && (!Number.isSafeInteger(cursor.upper) || cursor.upper < cursor.lower))) return null;
    return cursor;
  } catch {
    return null;
  }
}
