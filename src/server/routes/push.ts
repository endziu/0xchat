import type { Address } from '../../shared/address.ts';
import { deletePushSubscription, getPubkey, savePushSubscription } from '../db.ts';
import { json, readJson, getSessionAddress, type Context } from '../http.ts';
import { validatePushSubscription } from '../validation.ts';
import { pushMutationLimiter } from '../rate-limiters.ts';
import { VAPID_PUBLIC_KEY } from '../constants.ts';

export async function handleGetVapidPublicKey(_ctx: Context): Promise<Response> {
  if (!VAPID_PUBLIC_KEY) return json({ error: 'Push not configured' }, 503);
  return json({ publicKey: VAPID_PUBLIC_KEY });
}

/** Authenticate, rate-limit and read a JSON object body of at most 8 KiB. */
async function readMutation({ req, ip }: Context): Promise<{ address: Address; body: Record<string, unknown> } | Response> {
  const address = getSessionAddress(req);
  if (!address) return json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
  if (pushMutationLimiter.hit(`${ip}:${address}`)) {
    return json({ error: 'Too many requests. Wait a minute before retrying.', code: 'rate_limited' }, 429);
  }
  const body = await readJson(req, 8192);
  if (body instanceof Response && body.status === 413) {
    return json({ error: 'Push request exceeds 8 KiB.', code: 'payload_too_large' }, 413);
  }
  if (body instanceof Response || !body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid JSON object', code: 'invalid_request' }, 400);
  }
  return { address, body: body as Record<string, unknown> };
}

export async function handleSubscribePush(ctx: Context): Promise<Response> {
  const mutation = await readMutation(ctx);
  if (mutation instanceof Response) return mutation;
  const validation = validatePushSubscription(mutation.body);
  if (!validation.ok) {
    return validation.reason === 'host'
      ? json({ error: 'Unsupported push service', code: 'unsupported_push_service' }, 400)
      : json({ error: 'Invalid push subscription', code: 'invalid_request' }, 400);
  }
  if (!getPubkey(mutation.address)) {
    return json({ error: 'Register this identity again before enabling notifications.', code: 'registration_required' }, 409);
  }
  const { endpoint, keys } = validation.value;
  savePushSubscription(mutation.address, { endpoint, p256dh: keys.p256dh, auth: keys.auth });
  return json({ success: true }, 201);
}

export async function handleUnsubscribePush(ctx: Context): Promise<Response> {
  const mutation = await readMutation(ctx);
  if (mutation instanceof Response) return mutation;
  const endpoint = mutation.body['endpoint'];
  if (typeof endpoint !== 'string' || !URL.canParse(endpoint)) {
    return json({ error: 'Push endpoint required', code: 'invalid_request' }, 400);
  }
  deletePushSubscription(new URL(endpoint).href, mutation.address);
  return json({ success: true });
}
