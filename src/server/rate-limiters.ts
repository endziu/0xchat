import { RateLimiter } from './rate-limit.ts';

const MINUTE = 60_000;

// Per-route limits. Messages must tolerate fast normal chat (U1); auth and
// registration stay low. Keys identify the actor within each key space
// (e.g. `ip:address` for messages, `ip` for auth/register).

/** 120/min per ip+address — 2 messages/sec sustained, fast chat safe. */
export const messageLimiter = new RateLimiter({ max: 120, windowMs: MINUTE });

/** 240/min per ip across every address — bounds identity cycling while allowing
 * two identities behind a shared IP their full 120/min allowance each. */
export const messageIpLimiter = new RateLimiter({ max: 240, windowMs: MINUTE });

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
