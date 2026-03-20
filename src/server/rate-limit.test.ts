import { beforeEach, describe, expect, test } from 'bun:test';

// We need a fresh module for each test to reset state.
// Bun doesn't support module cache invalidation, so we test via the exported API.
import { isRateLimited } from './rate-limit.ts';

describe('isRateLimited', () => {
  // Use unique keys per test to avoid cross-test interference
  let keyPrefix: string;
  beforeEach(() => {
    keyPrefix = `test-${Date.now()}-${Math.random()}`;
  });

  test('allows requests under the limit', () => {
    const key = `${keyPrefix}:under`;
    for (let i = 0; i < 10; i++) {
      expect(isRateLimited(key)).toBe(false);
    }
  });

  test('blocks requests over the limit', () => {
    const key = `${keyPrefix}:over`;
    for (let i = 0; i < 10; i++) {
      isRateLimited(key);
    }
    expect(isRateLimited(key)).toBe(true);
  });

  test('different keys are independent', () => {
    const key1 = `${keyPrefix}:a`;
    const key2 = `${keyPrefix}:b`;
    for (let i = 0; i < 10; i++) {
      isRateLimited(key1);
    }
    expect(isRateLimited(key1)).toBe(true);
    expect(isRateLimited(key2)).toBe(false);
  });
});
