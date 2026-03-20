import { describe, expect, test } from 'bun:test';

// Load utils.js via dynamic import to get the globals
// Since utils.js sets window globals, we simulate that with globalThis
const script = await Bun.file(
  new URL('./utils.js', import.meta.url).pathname,
).text();

// Execute in a context that provides a window-like object
const fn = new Function('window', script);
const fakeWindow: Record<string, unknown> = {};
fn(fakeWindow);

const hexToBytes = fakeWindow['hexToBytes'] as (hex: string) => Uint8Array;
const bytesToHex = fakeWindow['bytesToHex'] as (bytes: Uint8Array) => string;
const walletErrorMessage = fakeWindow['walletErrorMessage'] as (e: unknown) => string;

describe('hexToBytes / bytesToHex', () => {
  test('round-trip empty', () => {
    const bytes = hexToBytes('');
    expect(bytes.length).toBe(0);
    expect(bytesToHex(bytes)).toBe('');
  });

  test('round-trip single byte', () => {
    expect(bytesToHex(hexToBytes('ff'))).toBe('ff');
    expect(bytesToHex(hexToBytes('00'))).toBe('00');
    expect(bytesToHex(hexToBytes('0a'))).toBe('0a');
  });

  test('round-trip multi-byte', () => {
    const hex = 'deadbeef01020304';
    expect(bytesToHex(hexToBytes(hex))).toBe(hex);
  });

  test('produces correct Uint8Array', () => {
    const bytes = hexToBytes('ff00ab');
    expect(bytes).toEqual(new Uint8Array([255, 0, 171]));
  });
});

describe('walletErrorMessage', () => {
  test('maps disconnected error', () => {
    expect(walletErrorMessage(new Error('Wallet disconnected'))).toContain('disconnected');
  });

  test('maps not initialized error', () => {
    expect(walletErrorMessage(new Error('Wallet not initialized'))).toContain('not ready');
  });

  test('maps account mismatch error', () => {
    expect(walletErrorMessage(new Error('does not match expected'))).toContain('account changed');
  });

  test('returns default for unknown errors', () => {
    expect(walletErrorMessage(new Error('something random'))).toBe('Signature rejected.');
  });

  test('handles non-Error values', () => {
    expect(walletErrorMessage('string error')).toBe('Signature rejected.');
    expect(walletErrorMessage(null)).toBe('Signature rejected.');
    expect(walletErrorMessage(undefined)).toBe('Signature rejected.');
  });
});
