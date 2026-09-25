import webpush from 'web-push';

export type SendPush = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: undefined,
  options: { TTL: number; timeout: number; signal: AbortSignal },
) => Promise<unknown>;

// RFC 9110 HTTP-date: IMF-fixdate, obsolete RFC 850 and asctime forms.
const IMF_DATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) (?:GMT|UTC)$/;
const RFC850_DATE = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME_DATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([12]\d|3[01]| [1-9]) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function httpDateMs(value: string, now: number): number | undefined {
  const imf = IMF_DATE.exec(value);
  const rfc850 = RFC850_DATE.exec(value);
  const asctime = ASCTIME_DATE.exec(value);
  if (!imf && !rfc850 && !asctime) return undefined;
  const weekday = imf?.[1] ?? rfc850?.[1].slice(0, 3) ?? asctime![1];
  const day = Number(imf?.[2] ?? rfc850?.[2] ?? asctime![3]);
  const month = MONTHS.indexOf(imf?.[3] ?? rfc850?.[3] ?? asctime![2]);
  let year = Number(imf?.[4] ?? rfc850?.[4] ?? asctime![7]);
  const hour = Number(imf?.[5] ?? rfc850?.[5] ?? asctime![4]);
  const minute = Number(imf?.[6] ?? rfc850?.[6] ?? asctime![5]);
  const second = Number(imf?.[7] ?? rfc850?.[7] ?? asctime![6]);
  if (rfc850) {
    year += Math.floor(new Date(now).getUTCFullYear() / 100) * 100;
    const candidate = new Date(0);
    candidate.setUTCFullYear(year, month, day);
    candidate.setUTCHours(hour, minute, second, 0);
    const fiftyYears = new Date(now);
    fiftyYears.setUTCFullYear(fiftyYears.getUTCFullYear() + 50);
    if (candidate.getTime() > fiftyYears.getTime()) year -= 100;
  }
  // setUTCFullYear handles 00–99 without Date.UTC's automatic +1900, and
  // the component check rejects normalized impossible dates and clock times.
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day ||
      date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second ||
      WEEKDAYS[date.getUTCDay()] !== weekday) return undefined;
  return date.getTime();
}

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
    const date = httpDateMs(trimmed, now);
    if (date === undefined) return undefined;
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
