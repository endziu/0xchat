# Push notifications for offline users

## Status: implemented

Standards-based **Web Push** (VAPID), sent as a **payload-less wakeup**. See
`src/server/push.ts`, `src/server/routes/push.ts`, `public/sw.js`, and
`src/client/hooks/usePushSubscription.ts` for the implementation.

## Design

0xChat is a Preact PWA with an existing service worker, not an Expo or native
app, so Web Push (not direct APNs/FCM integration) is the right fit — it
already routes through the browser-selected push service, and on iOS/iPadOS
Home Screen apps that service is APNs with no Apple Developer Program
membership required ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).

SSE remains the live-delivery channel. Push is a side-channel wakeup only —
not the message transport, not a delivery/read receipt, not durable storage.
The server persists the E2E-encrypted message and notifies over SSE first;
push is fired after, fire-and-forget, and never blocks or fails the send.

The web mechanism: a browser creates a `PushSubscription` tied to the service
worker (unique endpoint + encryption material); the app server posts to that
endpoint and the browser can wake the service worker while the page/browser
is inactive ([W3C Push API](https://www.w3.org/TR/push-api/)). Payload
confidentiality is standardized by [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291.html);
VAPID application-server identity by [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292.html).
Delivery is best-effort — a provider may delay, expire, coalesce, or drop a
push, so full message sync on reconnect (already how the app works) remains
the real recovery mechanism, never push.

## Privacy: no payload, ever

0xChat's core value is E2E encryption, and a push payload transits the
browser-selected relay (FCM/Mozilla/Apple) in transit — visible to that
relay, not just to us. So the payload is **empty**: `sendNotification` is
called with no second argument. The service worker's `push` handler ignores
`event.data` entirely and shows a static "0xChat / New message" from its own
hardcoded strings (`public/sw.js`). The relay learns only that some
subscription got pinged, at some time — the unavoidable floor of the
protocol, nothing more. No sender/recipient address, message id, or
conversation hint is ever included.

One consequence: tapping the notification always opens `/chat` (the
conversation list), never a specific thread — the service worker has no
thread info to route to. This is an intentional trade for privacy, not an
oversight.

## Server

**Config** (`src/server/constants.ts`): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT`, read from env. Soft-disabled (not a hard boot failure) if
unset, so dev works without them configured. See `.env.example`.

**Storage** (`src/server/db.ts`): `push_subscriptions(endpoint PK, address,
p256dh, auth, created_at)`, indexed on `address`. One address can hold
multiple subscriptions (phone, desktop, multiple browsers) — `pushNotify`
fans out to all of them. Rows are purged on account deletion
(`deletePushSubscriptionsForAddress`, wired into `handleDeleteAddress` in
`account.ts`) and pruned individually when a provider reports a subscription
dead (404/410 from `sendNotification`, per RFC 8030).

**Routes** (`src/server/routes/push.ts`, wired in `router.ts`):
- `GET /api/push/vapid-public-key` — unauthenticated, returns the public key (or 503 if unconfigured).
- `POST /api/push/subscribe` — authenticated (bearer session), upserts the subscription under the session address. The address is never taken from the request body.
- `POST /api/push/unsubscribe` — authenticated, scoped delete by `(address, endpoint)`.

**Trigger** (`src/server/routes/messages.ts`, `handleSendMessage`): after the
existing SSE `notify()` calls, `pushNotify(recipient, ttl)` fires
fire-and-forget (not awaited, errors caught and logged, never fails the
send). `ttl` is the message's own TTL (already validated against
`VALID_TTLS`), passed through as the Web Push `TTL` header
([RFC 8030 §5.2](https://www.rfc-editor.org/rfc/rfc8030.html#section-5.2)) —
capping delivery to the message's own remaining lifetime, since messages can
expire in as little as 5 seconds and a push arriving after that would be
misleading.

**Not implemented — deferred:**
- `pushsubscriptionchange` handling in the service worker (subscriptions can
  refresh/expire browser-side per the W3C spec; currently a stale client-side
  subscription is only cleaned up server-side once a push to it 404s/410s).
- Installation-level presence suppression (e.g. not pushing to a device that
  already has the conversation open via SSE). Current behavior always pushes
  to every subscription for the recipient address regardless of SSE state —
  simpler, but can double-notify a device that's already live. Preferred
  over the alternative failure mode (silently missing an offline device).

## Client

**Opt-in** (`src/client/hooks/usePushSubscription.ts`): never auto-subscribes
— browsers block/ignore `Notification.requestPermission()` unless it's called
from a direct user gesture. The hook only checks for an *existing*
subscription on mount; `subscribe()` is wired to an explicit "Enable
notifications" button in the settings panel (`Layout.tsx`), which requests
permission → `pushManager.subscribe({ userVisibleOnly: true,
applicationServerKey })` → uploads via `POST /api/push/subscribe`. Logout
unsubscribes first (`App.tsx`), both browser-side and server-side.

**Service worker** (`public/sw.js`, bumped to `VERSION = 'v2'`): `push` shows
the generic notification (see above); `notificationclick` focuses an
existing window or opens `/chat`.

## Testing notes

`bun run typecheck`, `bun run lint`, and `bun run test` all pass. Server-side
dispatch was verified end-to-end against a fake push receiver (message send
→ `pushNotify` → `web-push.sendNotification` invoked correctly, no payload).
The full browser click-through (grant permission → background tab → receive
→ tap to open) still needs a manual pass — see the PR test plan. Production needs
`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` added to the droplet's
environment for the systemd `0xChat` unit before this does anything there.
iOS Safari requires 16.4+ and the app installed to the Home Screen — regular
in-browser Safari has no `PushManager`, which the client's `supported` check
already handles by hiding the toggle.
