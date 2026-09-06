# Notification implementation review

Date: 2026-09-06
Part of #65 / resolves #66

Audit of the current 0xChat notification stack — Web Push (VAPID) + service worker for the background path, SSE for the foreground path — rating each area **sound / fixable in place / unsound** so #68 (iterate vs rebuild) can be decided on evidence. The repo at `main` (`adf3f52`) is the primary source; standards claims cite the spec or official doc in the Sources list. All checks pass on this tree: `bun run typecheck`, `bun run lint`, and the full `bun run test` (230 tests across 31 files, 0 failures).

## Summary table

| Area | Rating | One-line reason |
|---|---|---|
| Server: VAPID handling | sound | Keys from env, soft-disabled when missing, `web-push` 3.6.7 signs per RFC 8292; rotation is documented but nothing detects a key mismatch (see subscription lifecycle). |
| Server: push routes | fixable in place | Subscribe is authenticated, validated, rate-limited; unsubscribe is unlimited and neither route caps endpoints per identity. |
| Server: subscription storage & identity binding | fixable in place | Endpoint is the primary key and `INSERT OR REPLACE` re-binds it to whichever session uploads last; rows orphan when a pubkey is pruned; 404/410 pruning is the only cleanup. |
| Server: endpoint allowlist | sound | Exact/subdomain match on four push services, HTTPS only, structured rejection reasons; #44 shipped as designed. |
| Server: rate limits | fixable in place | Subscribe and SSE-token minting are limited; unsubscribe is not; failed outbound pushes (non-404/410) are retried on every message with no backoff. |
| Client: subscription lifecycle | fixable in place | Serial queue + generation claiming is correct and well tested; missing `pushsubscriptionchange`, VAPID-mismatch (`InvalidStateError`) handling, and a dev-mode queue stall. |
| Client: permission handling | fixable in place | Prompt is gesture-driven and denial is surfaced; permission state is read once and the prompt can run after a queued network round-trip. |
| Client: service worker | fixable in place | Cache strategy and no-cache serving are right; no `pushsubscriptionchange`, no foreground suppression, click routing focuses an arbitrary window. |
| Client: SSE foreground path | fixable in place | Reconnect/backoff/token re-mint is correct and tested; there is no missed-event recovery (no `id`/`Last-Event-ID`, no refetch on reopen). |
| Content-free payload | sound (keep) | Load-bearing for lock-screen/OS and service-worker exposure, not for the push service (RFC 8291 would cover that); the push service sees timing and the message TTL regardless. |
| Test coverage & #44 | fixable in place | Strong unit coverage of the state machines and validation; `pushNotify`, `sw.js`, unsubscribe route, DB push functions and the hook are untested; #44 is merged (PR #50) minus Brave evidence. |

## Executive summary (for #68)

1. The architecture — SSE foreground, payload-less Web Push background, subscriptions bound to a burner identity via session — is coherent and nothing in it is unsound. No area needs a rewrite to be made correct.
2. What is load-bearing: the identity/session binding on subscribe (`src/server/routes/push.ts:15-24`), the endpoint host allowlist as an SSRF guard (`src/server/validation.ts:27-36`), the serial queue + generation contract on the client (`src/client/lib/push-queue.ts`, `push-ops.ts`), and the SSE token/cap/reconnect design (`src/server/routes/events.ts`, `src/client/lib/sse-connection.ts`).
3. The content-free payload is a real privacy decision but a narrower one than the docs imply: it hides counterparty and content from the device's notification surface and keeps the service worker key-free; it does not hide who-got-woken-when from the push service, and the message TTL is sent to the push service in the clear (`src/server/push.ts:27`). A rebuild could add an encrypted payload without changing what the push service learns, at the cost of putting decryption state in the service worker.
4. What is broken today (all fixable in place): no `pushsubscriptionchange` handler (browser-rotated endpoints go dead until the next session start); no handling of a VAPID key rotation (subscribe throws `InvalidStateError`, re-uploads of the old subscription fail forever with a non-404 status and are never pruned); push fires even when the recipient has a live SSE stream, so a focused tab gets both; SSE reconnects never refetch, so messages during an outage are missed until navigation.
5. What is missing: any test of the send path (`pushNotify`), of `sw.js`, of the unsubscribe route, of the DB push functions and the account-delete cascade; a per-identity cap on stored endpoints; cleanup of subscriptions when a pubkey is pruned; a non-404/410 failure budget for outbound pushes; Brave endpoint evidence for #44's follow-up.
6. Push TTL is tied to the sender-selected lifetime (`src/server/push.ts:27`). Under the agreed-but-unimplemented expiry model (`docs/domain-behavior.md`, 24 h unopened retention) that coupling is wrong: a 5 s message would drop its wakeup after 5 s while the message itself waits up to 24 h.
7. iOS installed-PWA support is not addressed by code at all (no `Notification`-absent path beyond hiding the UI, no badge, no gesture-window care); the capability matrix (#67) should settle whether the current design's ceiling is acceptable.
8. Recommendation from this review alone: the stack is a sound base to iterate on. The rebuild question hinges on #67 (ceiling) and on whether a payload is wanted for click routing, not on defects found here.

---

## Server: VAPID handling

**What it does.** Keys and subject come from env (`src/server/constants.ts:50-52`); when either key is missing the server warns once and push is soft-disabled (`constants.ts:53-55`, `src/server/push.ts:5-8,14`). `web-push` 3.6.7 (`package.json`, `bun.lock` line 384) is configured once with `setVapidDetails` (`push.ts:6-8`) and signs each request; the public key is served unauthenticated at `GET /api/push/vapid-public-key` (`src/server/routes/push.ts:9-12`, 503 when unset). `.env.example:14-19` documents generation and warns that rotation invalidates subscriptions.

**Findings.**
- The default `VAPID_SUBJECT` is the maintainer's personal mailto (`constants.ts:52`). RFC 8292 §2.1 says `sub` SHOULD be a contact URI for the application server; hard-coding an individual's address as the fallback for every deployment is a configuration smell, not a bug.
- Key rotation is documented but not handled anywhere: after rotation, existing browser subscriptions are restricted to the old key (RFC 8292 §4.2, push service MUST reject a mismatched key), so sends return 401/403, which `pushNotify` logs and retries forever (`push.ts:32-37`), and `pushManager.subscribe` with the new key throws `InvalidStateError` while the old subscription exists (Push API §7.1). See subscription lifecycle.
- No JWT caching: `web-push` mints a JWT per send. Fine at this scale; noted for a rebuild that batches.

**Tests.** None exercise VAPID. The disabled path is only visible as the warn line in `src/server/routes/events.test.ts` output. `handleGetVapidPublicKey` is untested.

**Rating: sound.** Configuration and signing are correct and delegated to a maintained library; the rotation gap is a lifecycle problem, filed under the client lifecycle section.

## Server: push routes

**What it does.** `POST /api/push/subscribe` requires a session (`routes/push.ts:15-19`), rate-limits per `ip:address` (`:21-24`), parses JSON, validates with `validatePushSubscription` (`:33-43`) mapping the `host` reason to `{ error: 'Unsupported push service', code: 'unsupported_push_service' }` and everything else to the generic 400, then upserts (`:46-51`, 201). `POST /api/push/unsubscribe` requires a session, takes `{ endpoint }` and deletes only rows matching both endpoint and session address (`:56-77`, `db.ts:317-320`). Routes are registered in `src/server/router.ts:391-393`.

**Findings.**
- `handleUnsubscribePush` has no rate limiter (`routes/push.ts:56-77`) while subscribe does. The write is a cheap indexed delete scoped to the caller's own address, so this is a consistency gap rather than a DoS vector.
- No cap on endpoints per address. An identity can store one row per distinct endpoint string; with the subscribe limiter at 10/min per ip+address (`rate-limiters.ts:29`) and registration at 10/min per IP (`:26`), one IP can add on the order of 100 rows/min indefinitely, each up to 2000 chars of endpoint (`validation.ts:51`). Issue #26 bounded the other tables; this one was not covered.
- Unsubscribe returns `success: true` even when no row matched. Harmless.
- Subscribe stores `p256dh`/`auth` that the send path never uses (payload-less sends need no encryption, RFC 8291 §2 applies only to payloads). Keeping them is right if a payload is ever added; validating them (`validation.ts:69-76`) at least rejects garbage.

**Tests.** `src/server/routes/push.test.ts` — "returns a stable code for an unsupported push service" (asserts no row is stored), "keeps the generic response for malformed subscriptions" (null body, bad auth). No test for the happy path storing a row, for 401 without a session, for the limiter, or for `handleUnsubscribePush` at all.

**Rating: fixable in place.** Add the unsubscribe limiter, a per-address endpoint cap, and route tests; no design change needed.

## Server: subscription storage & identity binding

**What it does.** Table `push_subscriptions(endpoint PRIMARY KEY, address, p256dh, auth, created_at)` with an index on `address` (`src/server/db.ts:58-66`). `upsertPushSubscription` is `INSERT OR REPLACE` keyed on endpoint with the address lowercased (`db.ts:301-311`). Three deletes: by endpoint (`:313-315`, used by the send path), by endpoint+address (`:317-320`, unsubscribe route), by address (`:322-325`, account delete). `pushNotify` fans out to every row for the recipient (`db.ts:333-338`, `push.ts:15-16`). Account deletion removes sessions, conversations, push subscriptions and the pubkey in that order (`src/server/routes/account.ts:24-28`).

**Findings.**
- *Can one identity's subscription be attached to another?* Yes, by design and by accident. Because endpoint is the PK and the upsert is `OR REPLACE`, any authenticated identity that presents an endpoint string re-binds it to itself. The intended case is identity switch in the same browser. The unintended case: an endpoint URL is a capability URL; anyone who learns a victim's endpoint (leaked logs, a compromised page) can bind it to their own address and cause "New message" notifications on the victim's device whenever the attacker receives mail. Impact is nuisance-level (no content, no cross-identity data), but there is no ownership check beyond "you sent it".
- *Identity deletion / logout:* client calls `push.unsubscribe()` and `idLogout()` concurrently (`src/client/components/App.tsx:30-33`); the server side of logout deletes all subscriptions for the address anyway (`account.ts:27`), so the browser-side `sub.unsubscribe()` (`push-ops.ts:109`) is what matters and it always runs. If the unsubscribe's server call lands after the session is revoked it 401s, `api.ts:39-51` clears the (already cleared) token and dispatches `auth:expired` (the `/api/push/` path is not in the exclusion list at `api.ts:47`) — harmless here because logout is in progress, but it is the kind of ordering that a test should pin.
- *Identity import (rotation):* `createIdentityTransition` unsubscribes first, then revokes, clears, registers and logs in (`src/client/lib/identity-transition.ts:21-44`), so the new token's session-start re-upload finds no browser subscription and the user must re-enable. Correct and tested (`identity-transition.test.ts`, "stops old push and session before registering, logging in, and committing the new identity", "continues safely when push unsubscribe fails").
- *Export/import to another device:* each device has its own endpoint, all rows share the address, fan-out covers multi-device. Sound.
- *Orphaned rows:* `deleteInactivePubkeys` (`db.ts:124-126`, run every 30 s from `server.ts:8-12`) prunes the identity but not its `push_subscriptions`; there is no foreign key. A pruned address cannot receive messages, so `pushNotify` never runs for it and the rows never hit the 404/410 path. They persist forever unless the identity re-registers and unsubscribes.
- *Stale-subscription cleanup:* only on a 404 or 410 from the push service (`push.ts:32-35`). RFC 8030 §7.3 mandates 404 for an expired subscription; 410 is FCM practice (web-push README). Any other failure is logged and the row kept (`:36-37`).
- Session expiry (24 h, `constants.ts:44`) does not touch subscriptions; pushes keep flowing to a device whose session lapsed. That is the desired behaviour for a background channel and is consistent with the server already deciding delivery per address, not per session.

**Tests.** No test touches the DB push functions (`grep -i push src/server/db.test.ts` is empty), the account-delete cascade, or fan-out to multiple endpoints.

**Rating: fixable in place.** Keep the schema; add a cascade on pubkey prune, a per-address cap, and decide whether an endpoint may be re-bound across addresses (reject, or require the old owner's unsubscribe first).

## Server: endpoint allowlist

**What it does.** `ALLOWED_PUSH_HOSTS` = `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`, `notify.windows.com` (`src/server/validation.ts:27-32`; Windows added in `607d18d`). Match is exact or `.`-suffixed subdomain (`:34-36`), HTTPS only (`:61`), endpoint ≤ 2000 chars (`:51`), keys must be base64url of 65 and 16 bytes (`:69-76`). The result is a discriminated union with reasons `shape | protocol | p256dh | auth | host(+hostname)` (`:43-46`).

**Findings.**
- Purpose (SSRF guard, `validation.ts:25-26`) is served: the server only ever opens outbound connections to four vendors.
- Cost: every new browser vendor or vendor endpoint change is an allowlist edit and a deploy. #44 showed distro Chromium using `jmt17.google.com` and being rejected; the fix correctly did not allowlist it because Chromium itself reports `DEPRECATED_ENDPOINT` for that registration (issue #44; CEF issue 4078 documents the same error class). Brave's endpoint host has still not been captured (#44 "out of scope").
- The `hostname` of a rejected endpoint is logged (`routes/push.ts:36`); the full endpoint is not. Good.

**Tests.** `src/server/validation.test.ts` — accepts FCM, Mozilla, Apple, Windows subdomain; "identifies a deprecated Chromium endpoint as an unsupported host"; rejects lookalike `notify.windows.com.attacker.example` and arbitrary host; "distinguishes malformed shape, protocol, and key material".

**Rating: sound.** The trade-off (maintenance burden vs SSRF surface) is deliberate and the implementation matches its tests.

## Server: rate limits

**What it does.** Sliding-window `RateLimiter` per route (`src/server/rate-limit.ts`). Push subscribe 10/min per `ip:address` (`rate-limiters.ts:29`, applied at `routes/push.ts:21`); SSE token mint 10/min per IP (`rate-limiters.ts:32`, `routes/events.ts:73`); SSE streams capped at 3 per address, checked before the token is consumed so a rejected client can retry (`constants.ts:48`, `events.ts:99-106`). Messages 120/min per ip+address and 240/min per IP (`routes/messages.ts:46`), which also bounds `pushNotify` calls per sender.

**Findings.**
- Unsubscribe unlimited (`routes/push.ts:56-77`); `vapid-public-key` unlimited (static, fine).
- Outbound push has no failure budget. A subscription whose push service answers anything other than 404/410 (401/403 after VAPID rotation, 413, 429, 5xx) is retried on every single message to that address forever (`push.ts:32-37`), with a log line each time. A recipient with such a row generates one dead HTTPS request per inbound message.
- `pushNotify` runs after the response is committed and errors are only logged (`messages.ts:90`), so push failures never slow or fail a send. Correct.
- SSE token mint at 10/min per IP is shared by all identities behind a NAT; with the reconnect loop's 1 s initial backoff (`sse-connection.ts:20`) a flapping network can exhaust it, after which the client backs off to 30 s and recovers. Acceptable, and the retry path is tested ("retries a failed token mint (e.g. rate-limited) with backoff").

**Tests.** `events.test.ts` — "rate-limits SSE token minting per ip", "bounds concurrent SSE connections per address", "concurrent admissions honor the cap synchronously". `server.test.ts` — "sustained fast chat never 429s (30-message burst)". No test for the push subscribe limiter.

**Rating: fixable in place.** Add the unsubscribe limiter, a limiter test for subscribe, and a failure counter/backoff on outbound sends.

## Client: subscription lifecycle (serial queue + generation claiming)

**What it does.** `usePushSubscription(token)` (`src/client/hooks/usePushSubscription.ts`) owns a `createSerialQueue()` and a generation counter. On every token change it claims a generation, enqueues a session-start re-upload (`:28-56`: `serviceWorker.ready` → `pushManager.getSubscription()` → `api.subscribePush` unless stale), and bumps the generation on cleanup (`:57-59`). `subscribe()` and `unsubscribe()` each claim a generation and enqueue `runSubscribeOp` / `runUnsubscribeOp` (`:62-97`). The queue runs ops strictly in order and keeps chaining after a rejection (`push-queue.ts:11-22`); `claimGeneration` returns an `isStale` predicate (`:26-29`). The op contract: once a browser subscription exists, local cleanup always completes even if superseded; only server writes and UI state are gated on staleness (`push-ops.ts:10-16`, enforced at `:66-75` and `:108-111`).

**Findings.**
- *Concurrent subscribe/unsubscribe and identity switch:* correct. Serialization means a stale session-start POST cannot land after a newer DELETE; the generation check means it does not write at all. The regression tests cover supersession at each await point (see Tests).
- *Page reload mid-flight:* subscribe interrupted after `pushManager.subscribe` but before upload leaves a browser subscription the server does not know; the next session-start re-upload repairs it (`push-reupload.ts:18-34`). Unsubscribe interrupted after the server delete but before `sub.unsubscribe()` (`push-ops.ts:108-109`) leaves the reverse: the next re-upload resurrects the row and the user's "disable" silently did not stick. Low frequency; worth a note in a rebuild.
- *No `pushsubscriptionchange` handler* (`grep pushsubscriptionchange src public` is empty). The Push API fires it when the browser refreshes, revokes or loses a subscription (Push API §10.4; MDN). Until the user next opens the app, the server holds a dead endpoint (pruned only on 404/410) and the device gets nothing.
- *VAPID key rotation:* `runSubscribeOp` calls `push.subscribe({ applicationServerKey })` (`push-ops.ts:58-61`) with whatever the server currently serves. If a subscription for the old key exists, the Push API rejects with `InvalidStateError` (§7.1), which the catch maps to "Could not enable notifications. Please try again." (`:80-86`) — a permanent failure presented as transient, and the session-start re-upload keeps uploading the old subscription, which then fails on send (see rate limits). Nothing compares `sub.options.applicationServerKey` to the served key.
- *Dev-mode stall:* `main.tsx:9-13` registers `sw.js` only in production builds, but the hook awaits `navigator.serviceWorker.ready` unconditionally inside the queue (`usePushSubscription.ts:37`, `:71`, `:91`). With no registration `ready` never resolves, so the re-upload op blocks the queue and every later subscribe/unsubscribe click is enqueued behind it and never runs, with no error shown. Dev-only (a leftover production SW on the same origin masks it), but it means the push path is untestable in `bun run dev`.
- *Supported gate:* `'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined'` (`:29`). On iOS Safari outside an installed web app `PushManager`/`Notification` are absent, so the UI is hidden rather than showing a "install first" hint (WebKit: push is only for Home Screen web apps).

**Tests.** `push-queue.test.ts` — sequential order, superseded op skips its write, chaining after rejection. `push-reupload.test.ts` — upload while current, no upload when superseded before/during the write, no-subscription no-op. `push-ops.test.ts` — happy paths, supersession before ready / after subscribe / during upload (browser sub removed), permission denied, unsupported-service message, generic retry message; unsubscribe supersession at ready / lookup / after server write. `identity-transition.test.ts` as above. The hook itself (`usePushSubscription.ts`) and the queue-plus-generation wiring across token changes have no test; each piece is tested in isolation.

**Rating: fixable in place.** The core contract is right and the test suite proves it; the gaps are missing event handlers and one mis-mapped error, not design flaws.

## Client: permission handling

**What it does.** Initial state is `Notification.permission` at mount or `null` when the API is absent (`usePushSubscription.ts:22-24`). `subscribe()` is only reachable from the "Enable notifications" button (`src/client/components/Layout.tsx:179`), never automatically (`usePushSubscription.ts:6-9`). `requestPushPermission` skips the prompt if superseded and discards a result that arrives after supersession (`push-permission.ts:16-26`). Denial sets "Notification permission was not granted." (`push-ops.ts:49-52`); a `denied` state replaces the button with "Notifications blocked — enable them in your browser/OS settings." (`Layout.tsx:174-175`); `pushError` is rendered below (`:184`).

**Findings.**
- The prompt is issued from inside a queued op (`usePushSubscription.ts:68-79`): the click enqueues, and if the session-start re-upload is still running (it awaits `serviceWorker.ready` plus a network POST), `Notification.requestPermission()` runs after that completes. Browsers tie permission prompts to user activation (MDN's `requestPermission` page: "the request should be made in response to user interaction"; WebKit requires the request "in response to direct user interaction"). A slow network can push the prompt outside the activation window, in which case it resolves `denied`/`default` without a dialog and the UI reports "not granted". Unverified in a browser — flagged as a risk, not a reproduced bug.
- Permission is read once; there is no `navigator.permissions.query({name:'notifications'})` change listener. If the user revokes in browser settings while the tab is open, `subscribed` stays `true` until reload; on reload the re-upload finds no subscription (browsers drop it on revoke) and `permission` reads `denied`, so the UI recovers. Acceptable.
- `granted` with no subscription (user granted earlier, then unsubscribed) shows "Enable notifications" and does not re-prompt (the browser returns `granted` immediately). Correct.

**Tests.** `push-permission.test.ts` — granted, denied, no prompt when superseded at entry, result discarded when superseded during prompt. `push-ops.test.ts` "permission denied: error set, no subscription created". No UI test of the `denied` branch.

**Rating: fixable in place.** Move the prompt ahead of the queue (or make the re-upload yield to a pending user op) and listen for permission changes; the model is otherwise right.

## Client: service worker (`public/sw.js`)

**What it does.** App-shell worker, `VERSION = 'v2'` hand-bumped (`sw.js:4`). Install pre-caches `/chat`, manifest, icon, favicon and calls `skipWaiting()` (`:11-15`); activate drops other cache names and `clients.claim()`s (`:17-24`). Fetch: GET same-origin only, `/api/` never touched (`:26-33`), navigations network-first with the shell as offline fallback (`:37-48`), other assets cache-first with background revalidation (`:52-65`). Push: ignores `event.data` and always shows a fixed "0xChat / New message" notification with tag `0xchat-message` and `data.url = '/chat'` (`:68-80`). Click: closes, focuses the first window client if any, else opens `/chat` (`:82-93`). Served with `Cache-Control: no-cache` (`src/server/routes/static.ts:13`); registered on `load` in production builds only (`main.tsx:9-13`).

**Findings.**
- *Update behaviour:* browsers treat a byte-different script as an update, check on navigation and on push/sync events at most every 24 h, and (Chrome ≥ 68) ignore HTTP caching for the script (web.dev, service worker lifecycle). `no-cache` serving plus `skipWaiting` + `claim` means a deploy takes effect on the next navigation. The manual `VERSION` only matters for cache-name rotation; hashed assets under `/assets/` make stale entries harmless. Sound.
- *Push while the tab is foreground:* `pushNotify` fires on every accepted message regardless of live SSE clients (`messages.ts:88-90`), and the worker never checks `clients.matchAll(...).focused` before `showNotification` (`sw.js:68-80`). A user with the conversation open gets the in-app message and an OS notification for the same event. web.dev's guidance is to skip the notification when a window client is focused; iOS requires a visible notification per push (WebKit: silent pushes revoke the subscription), so suppression must be a client-side focus check, not a silent handler. Either server-side skip when an SSE client is connected (loses the case of a backgrounded tab whose socket is suspended) or SW-side focus check (safe everywhere) would work.
- *Click routing:* focuses whichever window client comes first (`:86-89`), even one on a different route; with no payload the worker cannot deep-link to the conversation. This is the direct UX cost of content-free payloads.
- *Notification collapsing:* the fixed `tag` means N pushes collapse to one notification. Intended, and it means the device cannot count unread. No badge (`navigator.setAppBadge`) is used.
- *Missing `pushsubscriptionchange`:* see lifecycle.
- *`self.registration.showNotification` is always called*, so Chrome's "site updated in background" fallback and Safari's silent-push revocation are both avoided. Sound.

**Tests.** None. `sw.js` is plain JS outside `src/`, not linted (`lint` covers `src` and `server.ts`) and not type-checked.

**Rating: fixable in place.** The caching side is right; the push side needs two handlers (`pushsubscriptionchange`, focus check) and a test harness.

## Client: SSE foreground path

**What it does.** Server: `POST /api/events/token` mints a 30 s single-use token bound to the session address (`routes/events.ts:9,25-64,72-88`); `GET /api/events?token=` looks it up, enforces the per-address cap before consuming (`:99-106`), streams `event: ping` immediately and every 30 s (`:127-136`), and cleans up on cancel or heartbeat failure (`:113-119,138-140`). `notify` writes `event: <name>\ndata: <json>\n\n` with no `id` field (`src/server/sse.ts:35-52`). Client: `SseConnection` mints a token, opens `EventSource`, and on any error closes and re-dials after exponential backoff 1 s → 30 s with a fresh token (`sse-connection.ts:20-21,70-86,100-150`), resetting backoff on open. `useSSE` wires it to `connected` state (`hooks/useSSE.ts:19-33`); `ChatView` refreshes the conversation list and appends the message if the conversation is open (`ChatView.tsx:29-32,41`).

**Findings.**
- The comment block in `sse-connection.ts:1-18` is accurate against the HTML standard: a non-200 or wrong content type "fails the connection" and the user agent does not reconnect; a network error is retried with the same URL and the single-use token would 401. Driving recovery from the client is therefore required, not optional. Sound.
- *Missed-event recovery:* none. No `id:` lines are emitted, so the browser's `Last-Event-ID` mechanism is unused (and would not help across a token-per-connection design without server-side buffering). On reopen, `onOpen` only flips `connected` (`useSSE.ts:22`); nothing calls `refreshConversations`/`refreshMessages`. A message that arrives during a disconnect is invisible until the user navigates or reloads. `Layout.tsx:56-62` toasts on reconnect, so the user is told they were offline but not caught up.
- Both parties receive the message event (`messages.ts:88-89`), so a sender with two tabs sees its own send everywhere. Correct.
- `notify` swallows enqueue errors and drops the controller (`sse.ts:44-50`); the interval keeps running until the next heartbeat fails and calls cleanup. Bounded to 30 s. Fine.
- Multi-tab: three streams per address (`constants.ts:48`); a fourth tab loops on 429 with backoff, by design and tested.

**Tests.** `sse-connection.test.ts` — connect with minted token, recovery from 429 with backoff and fresh token, re-mint after a dropped open stream, backoff doubling and cap, reset on open, retry after failed mint, `close()` idempotent and stops recovery, close during in-flight mint, single reconnect on repeated errors, message and `user:disconnected` delivery, malformed data tolerated. `events.test.ts` — disconnect cleanup, cap, concurrent admissions, heartbeat disposal, token store expiry/single-use/prune, real-HTTP disconnect and replay rejection. `server.test.ts` "persists, fetches, streams, verifies, and decrypts both copies" covers the event on the wire. `sse.test.ts` covers the registry.

**Rating: fixable in place.** Connection management is the best-tested part of the stack; add a refetch on reopen (or an `id`/replay buffer) and it is complete.

## Content-free payload: is it load-bearing?

**What the push contains.** `webpush.sendNotification(subscription, undefined, { TTL })` (`src/server/push.ts:21-28`): no body, so no RFC 8291 encryption is performed (the library sends no payload when none is given). The request carries the VAPID JWT (`aud` = push service origin, `exp`, `sub` = `VAPID_SUBJECT`, RFC 8292 §2) and `TTL: <message ttl seconds>` (RFC 8030 §5.2 requires TTL). The worker ignores `event.data` and shows a fixed string (`sw.js:68-80`).

**What each party learns regardless.**
- *0xChat server:* sender, recipient, timestamp, TTL, ciphertext sizes, both parties' IPs and session tokens (`messages.ts:39-94`, `db.ts:169-190`). It already has every field a payload could contain except plaintext, which it never has. Content-free payloads add nothing against the server.
- *Push service (Google/Apple/Mozilla/Microsoft):* the endpoint (which it minted for a specific browser profile/device), the application server's identity (VAPID key + `sub`), the arrival time and frequency, and the TTL value. RFC 8030 §8.2 and Push API §4 both state the push service sees timing/frequency/size metadata regardless of encryption. What it does not learn: recipient address, sender, or content. With a payload it would additionally learn payload size, but RFC 8291 would keep the content opaque. So against the push service, content-free is a marginal win (no size channel) and the TTL leak is a small metadata loss: the sender's chosen lifetime bucket (`VALID_TTLS`, `constants.ts:43`) is visible to Google/Apple per message.
- *Device (lock screen, notification center, OS notification log, other apps with notification access):* sees "0xChat — New message" only. A payload that named the counterparty or previewed text would expose it here and in any OS-level notification history. This is the strongest privacy property of the current design, and it is not something RFC 8291 helps with.
- *Service worker:* holds no keys, decrypts nothing, caches nothing (`sw.js:1-3`). A payload-bearing design would need the identity's decryption capability inside the worker (or a server-side per-message token) and a story for what happens when the payload outlives the message's lifetime.

**Verdict.** Load-bearing for the device-side and worker-side threat model; not load-bearing for the push-service or 0xChat-server threat models. The #65 framing ("the relay never learns who messaged whom") is true today and would remain true under an RFC 8291-encrypted payload; the correct framing is "the push service and the device's notification surface learn nothing but 'wake up'". A rebuild can change the payload without weakening privacy against the push service, but must decide (a) whether the lock screen may name a counterparty, (b) whether the worker may hold decryption state, and (c) whether TTL should stop mirroring the message lifetime. A middle path — an encrypted opaque conversation hint used only for click routing, never displayed — preserves (a) and (b)'s conservative answers while fixing click routing.

**Rating: sound (keep as the default), with the TTL coupling to revisit.**

## Test coverage & #44

**What exists** (all green: `bun test` on the 11 in-scope files = 75 tests; full `bun run test` = 230 tests / 31 files).

| Layer | Tested | Not tested |
|---|---|---|
| Validation | `validation.test.ts` (7 cases incl. jmt17, lookalikes, reasons) | — |
| Subscribe route | `routes/push.test.ts` (unsupported code, generic 400s) | happy path row, 401, limiter, `handleUnsubscribePush`, `handleGetVapidPublicKey` |
| Send path | — | `pushNotify` entirely: fan-out, TTL, 404/410 pruning, non-404 failures (`grep pushNotify src --include=*.test.ts` empty) |
| DB | — | all `*PushSubscription*` functions, account-delete cascade |
| SSE server | `events.test.ts`, `sse.test.ts`, `server.test.ts` | — |
| SSE client | `sse-connection.test.ts` (11 cases) | `useSSE` hook, refetch-on-reopen (behaviour absent) |
| Push client libs | `push-ops`, `push-queue`, `push-permission`, `push-reupload`, `identity-transition`, `api` ("preserves a stable server error code") | `usePushSubscription` hook wiring, dev-mode stall |
| Service worker | — | everything |

**How #44 fits.** #44 (closed) diagnosed that distro Chromium registers against `jmt17.google.com` (Chromium's staging GCM endpoint), which the allowlist rejects, and that Chromium itself logs `DEPRECATED_ENDPOINT`, so allowlisting would not restore delivery. PR #50 (`697efc3`, merged 2026-09-02) implemented the proposal: structured `PushSubscriptionValidationResult` (`validation.ts:43-46`), the `unsupported_push_service` code (`src/shared/api-error.ts:1`, `routes/push.ts:35-41`), `ApiError.code` on the client (`api.ts:10-15,52-60`), an actionable non-retry message (`push-ops.ts:80-86`), and regression tests across `validation.test.ts`, `routes/push.test.ts`, `push-ops.test.ts`, `api.test.ts`. Every acceptance criterion in the issue is met by the current code; `jmt17` is not allowlisted. Still open from #44's "out of scope": capturing Brave's real endpoint host to decide whether it needs an allowlist entry. Nothing in this review changes #44's conclusion; it does show that the allowlist is the one place where "works on all popular browsers" is a maintenance commitment rather than a code property.

**Rating: fixable in place.** The untested surface is exactly the I/O edge (`web-push`, service worker, DB), which is where a mock/fake seam is cheap to add.

## Open questions for #68

1. Should push TTL follow the message lifetime (current), the unopened retention limit (24 h per `docs/domain-behavior.md`), or a fixed short value? This decides whether the push service learns the lifetime bucket and whether a 5 s message can wake an offline phone.
2. Should a focused tab suppress the OS notification (SW `clients.matchAll().focused` check), and should a connected SSE client suppress the push server-side? They fail differently on mobile background tabs.
3. Is an encrypted, never-displayed conversation hint in the payload acceptable for click routing, or must the payload stay empty? This is the only reason found to add a payload.
4. May an endpoint be re-bound across identities by a plain subscribe, or should the server require the previous owner's unsubscribe (or reject)?
5. What is the failure budget for a subscription whose push service returns non-404/410 errors — prune after N, back off, or alert?
6. Does `pushsubscriptionchange` + VAPID-mismatch handling belong in the worker (spec-recommended) or in the page's session-start re-upload (already exists)? The worker cannot authenticate to `/api/push/subscribe` without access to the session token.
7. Given #67's matrix, is the SSE-plus-Web-Push split acceptable for iOS (Home Screen only, gesture-bound permission, no silent push) or does iOS need a distinct foreground story?
8. Should `sw.js` move under `src/` (TypeScript, linted, testable) as part of any iteration?

## What could not be verified

- No browser was driven during this review. The permission-prompt-after-queue-delay risk, the dev-mode `serviceWorker.ready` stall, and the `InvalidStateError` on key rotation are read from code and spec, not reproduced.
- Chromium's `DEPRECATED_ENDPOINT` behaviour is taken from issue #44's captured logs and secondary sources (CEF issue 4078, Raspberry Pi forum thread); the Chromium source was not consulted.
- Whether Brave uses an allowlisted host is unknown (per #44, still uncaptured).
- Which push services return 410 vs 404 for dead subscriptions is taken from the `web-push` README and RFC 8030 §7.3, not observed.

## Sources

Repository files are cited inline as `path:line` against `main` at `adf3f52`. Issues and PRs: #44, #50 (`697efc3`), #65, #66, #68 in `endziu/0xchat`.

External:

- RFC 8030, Generic Event Delivery Using HTTP Push — §5.2 (TTL), §7.3 (subscription expiration, 404), §8.2 (privacy, traffic analysis). https://www.rfc-editor.org/rfc/rfc8030
- RFC 8292, Voluntary Application Server Identification (VAPID) — §2 (`aud`, `exp` ≤ 24 h), §2.1 (`sub`), §4.2 (restricted subscriptions, key mismatch MUST be rejected). https://www.rfc-editor.org/rfc/rfc8292
- RFC 8291, Message Encryption for Web Push — §2 (payload is what is encrypted), §3.1 (`p256dh`), §3.2 (`auth`, 16 octets). https://www.rfc-editor.org/rfc/rfc8291
- W3C Push API — §4 (push service sees timing/frequency/size), §7.1 (`subscribe()` with differing options rejects with `InvalidStateError`), §7.3 (`userVisibleOnly`), §10.4 (`pushsubscriptionchange`). https://www.w3.org/TR/push-api/
- WHATWG HTML, Server-sent events — §9.2.2 (non-200 / wrong content type: fail the connection), §9.2.3 (no reconnect after failure; reconnect with same URL after network error), §9.2.4/9.2.6 (`Last-Event-ID`). https://html.spec.whatwg.org/multipage/server-sent-events.html
- WHATWG Notifications API — §3.3 `requestPermission()` steps. https://notifications.spec.whatwg.org/
- MDN, `Notification.requestPermission()` — request should be made in response to user interaction. https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static
- MDN, `pushsubscriptionchange` event — fires on browser refresh/revocation/loss; re-subscribe with `oldSubscription.options`. https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/pushsubscriptionchange_event
- WebKit, Web Push for Web Apps on iOS and iPadOS (16.4) — Home Screen only, permission on direct user interaction, Badging API. https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Apple WWDC22, Meet Web Push for Safari — silent pushes (no visible notification) revoke the subscription. https://developer.apple.com/videos/play/wwdc2022/10098/
- web.dev, The service worker lifecycle — byte-different update, checks on navigation and push/sync (24 h), `skipWaiting`, `clients.claim`. https://web.dev/articles/service-worker-lifecycle
- web.dev, Common notification patterns — skip the notification when a window client is focused (`clients.matchAll`, `focused`). https://web.dev/articles/push-notifications-common-notification-patterns
- web-push-libs/web-push README — payload-less `sendNotification`, TTL default four weeks, `WebPushError.statusCode`, 404/410 meaning, `setVapidDetails` subject. https://github.com/web-push-libs/web-push
- chromiumembedded/cef issue 4078 — `DEPRECATED_ENDPOINT` from Chromium's GCM registration. https://github.com/chromiumembedded/cef/issues/4078
