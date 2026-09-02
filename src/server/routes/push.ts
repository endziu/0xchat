import { upsertPushSubscription, deletePushSubscriptionForAddress } from '../db.ts';
import { json, getSessionAddress } from '../http.ts';
import { isValidPushSubscription } from '../validation.ts';
import { RateLimiter } from '../rate-limit.ts';
import { VAPID_PUBLIC_KEY, log, warn } from '../constants.ts';
import type { Context } from '../http.ts';

const subscribePushRateLimiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });

export async function handleGetVapidPublicKey(_ctx: Context): Promise<Response> {
  if (!VAPID_PUBLIC_KEY) return json({ error: 'Push not configured' }, 503);
  return json({ publicKey: VAPID_PUBLIC_KEY });
}

export async function handleSubscribePush({ req, ip }: Context): Promise<Response> {
  const address = getSessionAddress(req);
  if (!address) {
    warn('[unauth] push subscribe no session', ip);
    return json({ error: 'Unauthorized' }, 401);
  }

  if (subscribePushRateLimiter.isRateLimited(`${ip}:${address}`)) {
    warn('[rate-limit] push-sub', address, ip);
    return json({ error: 'Too many requests' }, 429);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (!isValidPushSubscription(body)) {
    return json({ error: 'Invalid push subscription' }, 400);
  }

  upsertPushSubscription(address, body.endpoint, body.keys.p256dh, body.keys.auth);
  log('[push] subscribed', address);
  return json({ success: true }, 201);
}

export async function handleUnsubscribePush({ req, ip }: Context): Promise<Response> {
  const address = getSessionAddress(req);
  if (!address) {
    warn('[unauth] push unsubscribe no session', ip);
    return json({ error: 'Unauthorized' }, 401);
  }

  let body: { endpoint?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (typeof body.endpoint !== 'string' || !body.endpoint) {
    return json({ error: 'endpoint required' }, 400);
  }

  deletePushSubscriptionForAddress(address, body.endpoint);
  log('[push] unsubscribed', address);
  return json({ success: true });
}
