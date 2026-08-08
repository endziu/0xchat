import webpush from 'web-push';
import { deletePushSubscription, getPushSubscriptionsForAddress } from './db.ts';
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, log, warn, error } from './constants.ts';

const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// No payload: the push relay and service worker learn nothing beyond "deliver a wakeup".
export async function pushNotify(address: string): Promise<void> {
  if (!pushEnabled) return;
  const subs = getPushSubscriptionsForAddress(address);
  if (subs.length === 0) return;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        });
        log('[push] sent', address);
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          deletePushSubscription(sub.endpoint);
          warn('[push] pruned dead subscription', address);
        } else {
          error('[push] send failed', address, statusCode ?? err);
        }
      }
    }),
  );
}
