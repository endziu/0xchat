import { expect, test } from 'bun:test';
import { sendPushNotification } from './push-provider.ts';

const keys = {
  p256dh: Buffer.alloc(65, 1).toString('base64url'),
  auth: Buffer.alloc(16, 2).toString('base64url'),
};
function send(endpoint: string) {
  return sendPushNotification({ endpoint, keys }, undefined, {
    TTL: 123, timeout: 500, signal: AbortSignal.timeout(500),
  });
}

test('provider transport sends an empty POST with the remaining TTL and does not wait for a response body', async () => {
  let received: { method: string; body: string; ttl: string | null } | undefined;
  const provider = Bun.serve({ port: 0, async fetch(request) {
    received = { method: request.method, body: await request.text(), ttl: request.headers.get('TTL') };
    // Deliberately never end the response body. Status alone decides acceptance.
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1]));
    } }), { status: 201 });
  } });
  try {
    await send(provider.url.href);
    expect(received).toEqual({ method: 'POST', body: '', ttl: '123' });
  } finally {
    provider.stop(true);
  }
});

test.each([404, 410, 429, 503])('provider transport preserves failure status %s', async status => {
  const provider = Bun.serve({ port: 0, fetch: () => new Response(null, { status }) });
  try {
    await expect(send(provider.url.href)).rejects.toMatchObject({ statusCode: status });
  } finally {
    provider.stop(true);
  }
});

test('provider transport never follows redirects', async () => {
  let followed = false;
  const destination = Bun.serve({ port: 0, fetch: () => {
    followed = true;
    return new Response(null, { status: 201 });
  } });
  const provider = Bun.serve({ port: 0, fetch: () => Response.redirect(destination.url.href, 307) });
  try {
    await expect(send(provider.url.href)).rejects.toThrow();
    expect(followed).toBe(false);
  } finally {
    provider.stop(true);
    destination.stop(true);
  }
});
