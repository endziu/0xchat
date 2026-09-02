export interface RateLimiterOptions {
  /** Maximum requests allowed per key within the window. */
  max: number;
  /** Sliding window length. Default 60_000 ms. */
  windowMs?: number;
  /** Clock. Default Date.now; inject a fake in tests. */
  now?: () => number;
  /**
   * Registers the periodic cleanup pass; returns an unregister handle.
   * Default: unref'd setInterval, started lazily on the first hit — never at
   * module import. Inject a fake in tests to stay timer-free.
   */
  schedule?: (cleanup: () => void, ms: number) => () => void;
}

/**
 * Sliding-window rate limiter for a single route.
 *
 * Each instance tracks one key space (e.g. `ip:address`); routes create one
 * instance per endpoint with their own limit. `hit(key)` returns true when
 * the request must be rejected (429). Rejected hits do not record.
 */
export class RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private schedule: (cleanup: () => void, ms: number) => () => void;
  private readonly windows = new Map<string, number[]>();
  private disposeTimer: (() => void) | null = null;

  constructor({ max, windowMs = 60_000, now = Date.now, schedule = defaultSchedule }: RateLimiterOptions) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.schedule = schedule;
  }

  /** Number of keys currently tracked (for memory observability). */
  get size(): number {
    return this.windows.size;
  }

  hit(key: string): boolean {
    this.ensureCleanupStarted();
    const now = this.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    prune(timestamps, cutoff);

    if (timestamps.length >= this.max) return true;

    timestamps.push(now);
    return false;
  }

  /** Stops the periodic cleanup timer. Safe to call before the first hit. */
  stop(): void {
    this.disposeTimer?.();
    this.disposeTimer = null;
  }

  /**
   * Swaps the cleanup scheduler (test/ops seam for the per-route singletons).
   * Disarms any running timer; the new scheduler arms lazily on the next hit.
   */
  setSchedule(schedule: (cleanup: () => void, ms: number) => () => void): void {
    this.disposeTimer?.();
    this.disposeTimer = null;
    this.schedule = schedule;
  }

  private ensureCleanupStarted(): void {
    if (this.disposeTimer === null) {
      this.disposeTimer = this.schedule(() => this.cleanup(), this.windowMs);
    }
  }

  private cleanup(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      prune(timestamps, cutoff);
      if (timestamps.length === 0) this.windows.delete(key);
    }
  }
}

/** Drops window entries older than the cutoff, in place. */
function prune(timestamps: number[], cutoff: number): void {
  while (timestamps.length > 0 && timestamps[0]! < cutoff) {
    timestamps.shift();
  }
}

const defaultSchedule: NonNullable<RateLimiterOptions['schedule']> = (cleanup, ms) => {
  const timer = setInterval(cleanup, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

