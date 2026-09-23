import webpush from 'web-push';
import {
  claimPushWork,
  cleanupInvalidPushWork,
  completePushWork,
  getDuePushWork,
  markPushSubscriptionDead,
  recordPushTemporaryFailure,
  releasePushClaim,
  type PendingPushWork,
} from './db.ts';
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, log, warn, error } from './constants.ts';
import { pushSuppressingConnectionCount } from './sse.ts';
import { sendPushNotification, type SendPush } from './push-provider.ts';

const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export interface PushDispatcherOptions {
  /** Adapters must abort their transport and settle when options.signal is aborted. */
  send?: SendPush;
  concurrency?: number;
  pollIntervalMs?: number;
  sendTimeoutMs?: number;
}

let sendPush: SendPush = sendPushNotification;
let concurrency = 4;
let sendTimeoutMs = 15_000;
let timer: ReturnType<typeof setInterval> | undefined;
let enabled = false;
let dispatchingEpoch: number | null = null;
let epoch = 0;
const inFlight = new Map<string, number>();

const TEMPORARY_RETRY_BASE_MS = 60_000;
const TEMPORARY_RETRY_MAX_MS = 3_600_000;

export type PushFailureKind = 'temporary' | 'dead' | 'non_temporary';

/**
 * Explicit delivery-result classification. Only 408, 429, 5xx, and untagged
 * transport failures marked temporary by the outbound boundary (network
 * errors and timeouts) are temporary. Confirmed-dead 404/410 and everything
 * else — authentication or configuration failures, including local errors
 * without a provider status — never enter the temporary retry schedule.
 */
export function classifyPushFailure(error: unknown): PushFailureKind {
  const statusCode = (error as { statusCode?: unknown; temporary?: unknown })?.statusCode;
  if (typeof statusCode === 'number') {
    if (statusCode === 404 || statusCode === 410) return 'dead';
    if (statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599)) return 'temporary';
    return 'non_temporary';
  }
  return (error as { temporary?: unknown } | null)?.temporary === true ? 'temporary' : 'non_temporary';
}

/** One minute, doubling per failed attempt, capped at one hour. */
export function temporaryPushRetryDelayMs(attemptCount: number): number {
  return Math.min(TEMPORARY_RETRY_BASE_MS * 2 ** Math.max(0, attemptCount - 1), TEMPORARY_RETRY_MAX_MS);
}

/** Persist the next temporary due time; a longer valid provider delay wins. */
function temporaryRetrySchedule(attemptCount: number, providerRetryAfterMs: number | undefined): { dueAt: number; notBefore: number | null } {
  const now = Date.now();
  let dueAt = now + temporaryPushRetryDelayMs(attemptCount);
  let notBefore: number | null = null;
  if (providerRetryAfterMs !== undefined && providerRetryAfterMs > 0) {
    const providerDue = now + providerRetryAfterMs;
    if (providerDue > dueAt) {
      dueAt = providerDue;
      notBefore = providerDue;
    }
  }
  return { dueAt, notBefore };
}

function recordFailure(work: PendingPushWork, claimToken: string, providerRetryAfterMs: number | undefined): void {
  // The claim already incremented attempt_count, so the failed attempt is #attempt_count + 1.
  const { dueAt, notBefore } = temporaryRetrySchedule(work.attempt_count + 1, providerRetryAfterMs);
  recordPushTemporaryFailure(work, claimToken, dueAt, notBefore);
}

function timeout<T>(promise: Promise<T>, duration: number, controller: AbortController): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      const reason = Object.assign(new Error('push delivery timed out'), { temporary: true });
      controller.abort(reason);
      reject(reason);
    }, duration);
    handle.unref();
  });
  return Promise.race([promise, expired]).finally(() => {
    if (handle) clearTimeout(handle);
  });
}

async function deliver(work: PendingPushWork, activeEpoch: number): Promise<void> {
  const observed = { slot_id: work.slot_id, revision: work.revision, generation: work.generation };
  let claimToken: string | null = null;
  let retainInFlight = false;
  try {
    const now = Date.now();
    const ttl = Math.floor((work.deadline - now) / 1000);
    // Reclaim expired leases before consuming work, including suppressed work.
    claimToken = claimPushWork(observed, now, sendTimeoutMs + 1_000);
    if (!claimToken) return;
    if (ttl < 1 || pushSuppressingConnectionCount(work.address) > 0) {
      if (activeEpoch === epoch) completePushWork(observed, claimToken);
      return;
    }
    const controller = new AbortController();
    let providerSettled = false;
    const providerOperation = Promise.resolve().then(() => sendPush({
      endpoint: work.endpoint,
      keys: { p256dh: work.p256dh, auth: work.auth },
    }, undefined, { TTL: ttl, timeout: sendTimeoutMs, signal: controller.signal })).finally(() => { providerSettled = true; });
    try {
      await timeout(providerOperation, sendTimeoutMs, controller);
      log('[push] sent', work.address);
      if (activeEpoch === epoch) completePushWork(observed, claimToken);
    } catch (caught: unknown) {
      if (activeEpoch !== epoch) return;
      if (!providerSettled) {
        // Cancellation may settle on the next turn. Retain ownership until it
        // does, so neither replacement nor newer work overlaps the old transport.
        // A non-conforming injected adapter fails closed rather than overlapping.
        retainInFlight = true;
        error('[push] send timed out', work.address);
        void providerOperation.catch(() => {}).finally(() => {
          if (activeEpoch !== epoch) return;
          // A timeout is a temporary failure. The result is ambiguous, and the
          // accepted at-least-once policy permits the durable retry below.
          recordFailure(work, claimToken!, undefined);
          releasePushClaim(work.slot_id, claimToken!);
          if (inFlight.get(work.slot_id) === activeEpoch) inFlight.delete(work.slot_id);
          requestPushDispatch();
        });
        return;
      }
      const statusCode = (caught as { statusCode?: number })?.statusCode;
      const kind = classifyPushFailure(caught);
      if (kind === 'dead') {
        markPushSubscriptionDead(work.slot_id, work.revision);
        warn('[push] subscription needs repair', work.address);
      } else if (kind === 'temporary') {
        const retryAfterMs = (caught as { retryAfterMs?: number })?.retryAfterMs;
        recordFailure(work, claimToken, retryAfterMs);
        error('[push] send failed, retrying at backoff', work.address, statusCode);
      } else {
        // Authentication and configuration failures are not temporary: complete
        // the observed generation without scheduling a retry. Its pause and
        // repair state are owned by #90.
        completePushWork(observed, claimToken);
        error('[push] send failed, not retryable', work.address, statusCode ?? caught);
      }
    }
  } finally {
    if (claimToken && !retainInFlight && activeEpoch === epoch) releasePushClaim(work.slot_id, claimToken);
    if (!retainInFlight && inFlight.get(work.slot_id) === activeEpoch) inFlight.delete(work.slot_id);
  }
}

async function dispatch(activeEpoch: number): Promise<void> {
  if (!enabled || dispatchingEpoch === activeEpoch || activeEpoch !== epoch) return;
  dispatchingEpoch = activeEpoch;
  let dispatched = false;
  try {
    const now = Date.now();
    cleanupInvalidPushWork(now);
    const activeCount = [...inFlight.values()].filter(itemEpoch => itemEpoch === activeEpoch).length;
    const available = Math.max(0, concurrency - activeCount);
    if (available === 0) return;
    const work = getDuePushWork(now, Math.max(concurrency * 4, available))
      .filter(item => inFlight.get(item.slot_id) !== activeEpoch)
      .slice(0, available);
    dispatched = work.length > 0;
    for (const item of work) inFlight.set(item.slot_id, activeEpoch);
    await Promise.all(work.map(item => deliver(item, activeEpoch)));
  } finally {
    if (dispatchingEpoch === activeEpoch) dispatchingEpoch = null;
    if (dispatched && enabled && activeEpoch === epoch) queueMicrotask(() => void dispatch(activeEpoch));
  }
}

export function requestPushDispatch(): void {
  if (enabled) queueMicrotask(() => void dispatch(epoch));
}

export function startPushDispatcher(options: PushDispatcherOptions = {}): void {
  stopPushDispatcher();
  sendPush = options.send ?? sendPushNotification;
  concurrency = options.concurrency ?? 4;
  sendTimeoutMs = options.sendTimeoutMs ?? 15_000;
  enabled = options.send !== undefined || pushEnabled;
  if (!enabled) return;
  const activeEpoch = epoch;
  timer = setInterval(() => void dispatch(activeEpoch), options.pollIntervalMs ?? 1_000);
  timer.unref();
  requestPushDispatch();
}

export function stopPushDispatcher(): void {
  enabled = false;
  epoch++;
  if (timer) clearInterval(timer);
  timer = undefined;
  dispatchingEpoch = null;
  inFlight.clear();
}
