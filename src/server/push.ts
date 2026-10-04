import type { Address } from '../shared/address.ts';
import webpush from 'web-push';
import { deletePushSubscription, getPushSubscriptionsForAddress } from './db.ts';
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, log, warn, error } from './constants.ts';
import { pushSuppressingConnectionCount } from './sse.ts';

export type SendPush = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  options: { TTL: number },
) => Promise<unknown>;

const SEND_TIMEOUT_MS = 15_000;

const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// No payload: the push relay and service worker learn nothing beyond "deliver a wake-up".
const configuredSend: SendPush | null = pushEnabled
  ? (subscription, { TTL }) => webpush.sendNotification(subscription, null, { TTL, timeout: SEND_TIMEOUT_MS })
  : null;
let send = configuredSend;

/** Tests replace the transport; `undefined` restores the configured one. */
export function setPushSender(sender: SendPush | undefined): void {
  send = sender ?? configuredSend;
}

// Expired or unsubscribed (404/410), or made with other VAPID keys (401/403):
// only a new browser subscription fixes those.
const DEAD_STATUS = new Set([401, 403, 404, 410]);

/**
 * Wake the recipient's browsers once, unless one of them is already looking.
 * The deadline is fixed at acceptance: acceptance plus the unopened retention
 * limit. There is no retry; a failed wake-up is dropped and the next message
 * tries again.
 */
export async function pushNotify(address: Address, deadline: number): Promise<void> {
  const ttl = Math.floor((deadline - Date.now()) / 1000);
  const transport = send;
  if (!transport || ttl < 1 || pushSuppressingConnectionCount(address) > 0) return;
  await Promise.all(getPushSubscriptionsForAddress(address).map(async (subscription) => {
    try {
      await transport({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, { TTL: ttl });
      log('[push] sent', address);
    } catch (caught: unknown) {
      const statusCode = (caught as { statusCode?: unknown } | null)?.statusCode;
      if (typeof statusCode === 'number' && DEAD_STATUS.has(statusCode)) {
        deletePushSubscription(subscription.endpoint);
        warn('[push] removed dead subscription', address, statusCode);
        return;
      }
      // Messages can embed the endpoint URL, which is a capability.
      const message = String((caught as Error | null)?.message ?? caught).replaceAll(subscription.endpoint, '[endpoint]');
      error('[push] send failed', address, statusCode ?? message);
    }
  }));
}
