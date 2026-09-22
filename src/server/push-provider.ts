import webpush from 'web-push';

export type SendPush = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: undefined,
  options: { TTL: number; timeout: number; signal: AbortSignal },
) => Promise<unknown>;

/** web-push signs the request; fetch provides cancellation of the actual transport. */
export const sendPushNotification: SendPush = async (subscription, payload, options) => {
  const request = webpush.generateRequestDetails(subscription, payload, { TTL: options.TTL });
  const response = await fetch(request.endpoint, {
    method: request.method,
    headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])),
    body: request.body,
    signal: options.signal,
    // Match web-push: never follow a provider redirect to a different destination.
    redirect: 'error',
  });
  // Only the status is needed. Do not wait for (or retain) an unbounded provider body.
  await response.body?.cancel();
  if (!response.ok) throw Object.assign(new Error('Push provider rejected delivery'), { statusCode: response.status });
};
