type ScheduleCleanup = (cleanup: () => void, intervalMs: number) => () => void;

export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
  cleanupIntervalMs?: number | false;
  scheduleCleanup?: ScheduleCleanup;
}

function scheduleCleanup(cleanup: () => void, intervalMs: number): () => void {
  const timer = setInterval(cleanup, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export class RateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly now: () => number;
  private stopScheduledCleanup: (() => void) | undefined;
  private cleanupStopped = false;

  constructor(private readonly options: RateLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  isRateLimited(key: string): boolean {
    this.startCleanup();

    const now = this.now();
    const cutoff = now - this.options.windowMs;
    const timestamps = this.windows.get(key) ?? [];
    this.dropExpired(timestamps, cutoff);

    if (timestamps.length >= this.options.maxRequests) return true;

    timestamps.push(now);
    this.windows.set(key, timestamps);
    return false;
  }

  stop(): void {
    this.cleanupStopped = true;
    this.stopScheduledCleanup?.();
    this.stopScheduledCleanup = undefined;
  }

  private startCleanup(): void {
    if (this.cleanupStopped || this.stopScheduledCleanup || this.options.cleanupIntervalMs === false) return;

    const intervalMs = this.options.cleanupIntervalMs ?? this.options.windowMs;
    const scheduler = this.options.scheduleCleanup ?? scheduleCleanup;
    this.stopScheduledCleanup = scheduler(() => this.cleanup(), intervalMs);
  }

  private cleanup(): void {
    const cutoff = this.now() - this.options.windowMs;
    for (const [key, timestamps] of this.windows) {
      this.dropExpired(timestamps, cutoff);
      if (timestamps.length === 0) this.windows.delete(key);
    }
  }

  private dropExpired(timestamps: number[], cutoff: number): void {
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }
  }
}
