import { describe, expect, test } from 'bun:test';
import { RateLimiter, type RateLimiterOptions } from './rate-limit.ts';
import { noOpSchedule } from './rate-limit.test-utils.ts';

function makeLimiter(options: Omit<RateLimiterOptions, 'schedule'>): RateLimiter {
  return new RateLimiter({ ...options, schedule: noOpSchedule });
}

function fakeScheduler() {
  const calls: Array<{ fn: () => void; ms: number }> = [];
  let stopped = 0;
  const schedule = (fn: () => void, ms: number): (() => void) => {
    calls.push({ fn, ms });
    return () => {
      stopped += 1;
    };
  };
  return { calls, schedule, stopCount: () => stopped };
}

describe('RateLimiter', () => {
  test('allows requests up to max, rejects beyond', () => {
    const limiter = makeLimiter({ max: 10 });
    for (let i = 0; i < 10; i++) {
      expect(limiter.hit('key-a')).toBe(false);
    }
    expect(limiter.hit('key-a')).toBe(true);
    // Rejected requests do not extend the window
    expect(limiter.hit('key-a')).toBe(true);
  });

  test('keys are independent per user', () => {
    const limiter = makeLimiter({ max: 5 });
    for (let i = 0; i < 5; i++) {
      expect(limiter.hit('user-1')).toBe(false);
    }
    expect(limiter.hit('user-1')).toBe(true);
    // Other users unaffected
    expect(limiter.hit('user-2')).toBe(false);
    expect(limiter.hit('user-3')).toBe(false);
  });

  test('window expiry refills the full budget', () => {
    let clock = 1_000_000;
    const limiter = makeLimiter({ max: 3, windowMs: 60_000, now: () => clock });
    for (let i = 0; i < 3; i++) {
      expect(limiter.hit('k')).toBe(false);
    }
    expect(limiter.hit('k')).toBe(true);
    clock += 60_001;
    expect(limiter.hit('k')).toBe(false);
    expect(limiter.hit('k')).toBe(false);
    expect(limiter.hit('k')).toBe(false);
    expect(limiter.hit('k')).toBe(true);
  });

  test('sliding window: partial expiry frees only expired slots', () => {
    let clock = 0;
    const limiter = makeLimiter({ max: 3, windowMs: 1_000, now: () => clock });
    limiter.hit('k'); // t=0
    clock = 500;
    limiter.hit('k'); // t=500
    clock = 600;
    limiter.hit('k'); // t=600
    expect(limiter.hit('k')).toBe(true); // window full
    clock = 1_001; // t=0 entry expires; t=500 and t=600 remain
    expect(limiter.hit('k')).toBe(false); // one slot freed
    expect(limiter.hit('k')).toBe(true); // full again
  });

  test('no cleanup timer before first hit', () => {
    const { calls, schedule } = fakeScheduler();
    new RateLimiter({ max: 10, now: () => 0, schedule });
    expect(calls.length).toBe(0);
  });

  test('schedules cleanup lazily once on first hit, at windowMs', () => {
    const { calls, schedule } = fakeScheduler();
    const limiter = new RateLimiter({ max: 10, windowMs: 123_456, now: () => 0, schedule });
    limiter.hit('a');
    expect(calls.length).toBe(1);
    expect(calls[0]!.ms).toBe(123_456);
    limiter.hit('b');
    expect(calls.length).toBe(1);
  });

  test('cleanup pass frees stale keys and limiter keeps working', () => {
    let clock = 0;
    const { calls, schedule } = fakeScheduler();
    const limiter = new RateLimiter({ max: 2, windowMs: 1_000, now: () => clock, schedule });
    limiter.hit('a');
    limiter.hit('b');
    expect(limiter.size).toBe(2);
    clock = 5_000;
    calls[0]!.fn();
    expect(limiter.size).toBe(0);
    expect(limiter.hit('a')).toBe(false);
  });

  test('stop() disposes the timer and is safe before first hit', () => {
    const s1 = fakeScheduler();
    const neverUsed = new RateLimiter({ max: 1, now: () => 0, schedule: s1.schedule });
    neverUsed.stop();
    expect(s1.stopCount()).toBe(0);

    const s2 = fakeScheduler();
    const limiter = new RateLimiter({ max: 1, now: () => 0, schedule: s2.schedule });
    limiter.hit('a');
    limiter.stop();
    expect(s2.stopCount()).toBe(1);
  });

  test('setSchedule swaps the scheduler and disarms the old timer', () => {
    const s1 = fakeScheduler();
    const s2 = fakeScheduler();
    const limiter = new RateLimiter({ max: 1, now: () => 0, schedule: s1.schedule });
    limiter.hit('a');
    expect(s1.calls.length).toBe(1);
    limiter.setSchedule(s2.schedule);
    expect(s1.stopCount()).toBe(1);
    limiter.hit('b');
    expect(s2.calls.length).toBe(1);
  });

  test('burst: first max allowed, rest rejected', () => {
    const limiter = makeLimiter({ max: 10 });
    const results = Array.from({ length: 15 }, () => limiter.hit('burst'));
    for (let i = 0; i < 10; i++) {
      expect(results[i]).toBe(false);
    }
    for (let i = 10; i < 15; i++) {
      expect(results[i]).toBe(true);
    }
  });
});
