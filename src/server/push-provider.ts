import webpush from 'web-push';

export type SendPush = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: undefined,
  options: { TTL: number; timeout: number; signal: AbortSignal },
) => Promise<unknown>;

// The RFC 1123 HTTP-date form with the zones providers actually emit.
const HTTP_DATE = /^[A-Za-z]{3,9}, \d{1,2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} (?:GMT|UTC)$/;

/**
 * Parse a provider Retry-After header as positive milliseconds. Accepts the
 * RFC 9110 delta-seconds form (a non-negative integer) and the HTTP-date
 * form; anything unparseable, non-integer, non-finite or non-positive is not
 * a valid delay and is ignored.
 */
export function parseRetryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    if (!HTTP_DATE.test(trimmed)) return undefined;
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return undefined;
    ms = date - now;
  }
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** web-push signs the request; fetch provides cancellation of the actual transport. */
export const sendPushNotification: SendPush = async (subscription, payload, options) => {
  const request = webpush.generateRequestDetails(subscription, payload, { TTL: options.TTL });
  let response: Response;
  try {
    response = await fetch(request.endpoint, {
      method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])),
      body: request.body,
      signal: options.signal,
      // Match web-push: never follow a provider redirect to a different destination.
      redirect: 'error',
    });
  } catch (error) {
    // A rejected redirect is our own policy refusing a 3xx, not a temporary
    // network failure, so it stays untagged and leaves the retry schedule.
    if ((error as { code?: unknown })?.code === 'UnexpectedRedirect') throw error;
    // Network-level failure or cancellation: temporary at the transport boundary.
    throw Object.assign(error instanceof Error ? error : new Error('Push provider request failed'), { temporary: true });
  }
  // Only the status and the requested delay are needed. Do not wait for (or retain) an unbounded provider body.
  await response.body?.cancel();
  if (!response.ok) {
    throw Object.assign(new Error('Push provider rejected delivery'), {
      statusCode: response.status,
      retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after'), Date.now()),
    });
  }
};
