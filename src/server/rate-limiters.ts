import { RateLimiter } from './rate-limit.ts';

const MINUTE = 60_000;

// Per-route limits. Messages must tolerate fast normal chat (U1); auth and
// registration stay low. Keys identify the actor within each key space
// (e.g. `ip:address` for messages, `ip` for auth/register).

/** 120/min per ip+address — 2 messages/sec sustained, fast chat safe. */
export const messageLimiter = new RateLimiter({ max: 120, windowMs: MINUTE });

/** Auth challenge, per ip. */
export const authChallengeLimiter = new RateLimiter({ max: 10, windowMs: MINUTE });

/** Auth session, per ip. */
export const authSessionLimiter = new RateLimiter({ max: 10, windowMs: MINUTE });

/** Registration challenge, per ip. */
export const registerChallengeLimiter = new RateLimiter({ max: 10, windowMs: MINUTE });

/** Registration, per ip. */
export const registerLimiter = new RateLimiter({ max: 10, windowMs: MINUTE });

/** Push subscribe, per ip+address. */
export const pushSubscribeLimiter = new RateLimiter({ max: 10, windowMs: MINUTE });

/** SSE token, per ip. A live client re-mints only on reconnect. */
export const sseTokenLimiter = new RateLimiter({ max: 10, windowMs: MINUTE });
