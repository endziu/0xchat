import { enablePushSlot, listPushSlots, removePushSlot, PushSlotError } from '../push-slots.ts';
import { json, getSessionAddress, type Context } from '../http.ts';
import { validatePushSubscription } from '../validation.ts';
import { pushMutationLimiter } from '../rate-limiters.ts';
import { VAPID_PUBLIC_KEY } from '../constants.ts';
import type { PushSlotCondition } from '../../shared/push-slot.ts';

export async function handleGetVapidPublicKey(_ctx: Context): Promise<Response> {
  if (!VAPID_PUBLIC_KEY) return json({ error: 'Push not configured' }, 503);
  return json({ publicKey: VAPID_PUBLIC_KEY });
}

export async function handleListPush({ req }: Context): Promise<Response> {
  const address = getSessionAddress(req);
  if (!address) return json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
  return json(listPushSlots(address));
}

const opaqueId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-zA-Z0-9_-]{16,128}$/.test(value);

async function mutate({ req, ip }: Context, operation: 'enable' | 'reconcile' | 'remove'): Promise<Response> {
  const address = getSessionAddress(req);
  if (!address) return json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
  if (pushMutationLimiter.hit(`${ip}:${address.toLowerCase()}`)) {
    return json({ error: 'Too many requests. Wait a minute before retrying.', code: 'rate_limited' }, 429);
  }
  let body: Record<string, unknown>;
  try {
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) {
          void reader.cancel();
          return json({ error: 'Push request exceeds 8 KiB.', code: 'payload_too_large' }, 413);
        }
        chunks.push(value);
      }
    }
    body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    return json({ error: 'Invalid JSON object', code: 'invalid_request' }, 400);
  }
  if (!opaqueId(body.installation_id) || !Number.isSafeInteger(body.expected_revision)
    || (body.expected_revision as number) < 0
    || (body.slot_id !== undefined && !opaqueId(body.slot_id))
    || (operation !== 'enable' && !opaqueId(body.slot_id))
    || Object.keys(body).some(key => !['slot_id', 'installation_id', 'expected_revision', ...(operation === 'remove' ? [] : ['subscription'])].includes(key))) {
    return json({ error: 'Valid installation, slot and expected revision required. Update or refresh this client.', code: 'invalid_request' }, 400);
  }
  const condition: PushSlotCondition = { installation_id: body.installation_id, expected_revision: body.expected_revision as number,
    ...(body.slot_id === undefined ? {} : { slot_id: body.slot_id as string }) };
  try {
    if (operation === 'remove') return json(removePushSlot(address, condition));
    const validation = validatePushSubscription(body.subscription);
    if (!validation.ok) {
      return validation.reason === 'host'
        ? json({ error: 'Unsupported push service', code: 'unsupported_push_service' }, 400)
        : json({ error: 'Invalid push subscription', code: 'invalid_request' }, 400);
    }
    return json(enablePushSlot(address, { ...condition, subscription: validation.value }, operation === 'reconcile'), operation === 'enable' ? 201 : 200);
  } catch (err) {
    if (err instanceof PushSlotError) return json({ error: err.message, code: err.code }, 409);
    throw err;
  }
}

export const handleSubscribePush = (ctx: Context) => mutate(ctx, 'enable');
export const handleReconcilePush = (ctx: Context) => mutate(ctx, 'reconcile');
export const handleUnsubscribePush = (ctx: Context) => mutate(ctx, 'remove');
