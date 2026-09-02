import { describe, expect, test } from 'bun:test';
import { RateLimiter } from './rate-limit.ts';

describe('RateLimiter', () => {
  test('allows the configured number of requests, then limits the key', () => {
    const limiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 60_000,
      cleanupIntervalMs: false,
    });

    expect(limiter.isRateLimited('user')).toBe(false);
    expect(limiter.isRateLimited('user')).toBe(false);
    expect(limiter.isRateLimited('user')).toBe(true);
  });

  test('tracks keys independently', () => {
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      cleanupIntervalMs: false,
    });

    expect(limiter.isRateLimited('first-user')).toBe(false);
    expect(limiter.isRateLimited('first-user')).toBe(true);
    expect(limiter.isRateLimited('second-user')).toBe(false);
  });

  test('allows requests again after the window expires', () => {
    let now = 1_000;
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      now: () => now,
      cleanupIntervalMs: false,
    });

    expect(limiter.isRateLimited('user')).toBe(false);
    expect(limiter.isRateLimited('user')).toBe(true);

    now += 60_001;

    expect(limiter.isRateLimited('user')).toBe(false);
  });

  test('starts cleanup lazily and lets the owner stop it', () => {
    let scheduled = 0;
    let stopped = 0;
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      cleanupIntervalMs: 30_000,
      scheduleCleanup: (_cleanup, intervalMs) => {
        expect(intervalMs).toBe(30_000);
        scheduled += 1;
        return () => { stopped += 1; };
      },
    });

    expect(scheduled).toBe(0);
    limiter.isRateLimited('user');
    expect(scheduled).toBe(1);

    limiter.stop();
    expect(stopped).toBe(1);
  });
});
