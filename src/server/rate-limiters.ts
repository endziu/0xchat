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

/** SSE token, per ip. A live client re-mints only on reconnect. */
export const sseTokenLimiter = new RateLimiter({ max: 10, windowMs: MINUTE });

/** 120/min keyed by recipient address, shared across devices and networks.
 * Supports rapid history opening without multiplying an identity's allowance. */
export const openingLimiter = new RateLimiter({ max: 120, windowMs: MINUTE });
/** 240/min keyed by IP across recipients, bounding identity cycling while
 * allowing two recipients behind one IP their full allowance. */
export const openingIpLimiter = new RateLimiter({ max: 240, windowMs: MINUTE });

/** Loaded lifecycle refresh has its own budget, independent of opening/sending. */
export const stateLimiter = new RateLimiter({ max: 120, windowMs: MINUTE });
export const stateIpLimiter = new RateLimiter({ max: 240, windowMs: MINUTE });

/** Recovery pages have their own budget so catching up does not block other operations. */
export const recoveryLimiter = new RateLimiter({ max: 120, windowMs: MINUTE });
export const recoveryIpLimiter = new RateLimiter({ max: 240, windowMs: MINUTE });
