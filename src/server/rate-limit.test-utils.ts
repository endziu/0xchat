import type { RateLimiterOptions } from './rate-limit.ts';

/** No-op cleanup scheduler: rate-limit tests must not start real timers. */
export const noOpSchedule: NonNullable<RateLimiterOptions['schedule']> = () => () => {};
