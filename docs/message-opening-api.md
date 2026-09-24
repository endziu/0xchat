# Message delivery and opening contract

Implemented by issue #75. The release gate (issue #81, [below](#release-gate))
decides whether new messages use `legacy` or `recipient-opening` delivery.

## Delivery metadata

Message POST responses, conversation GET messages and SSE `message` events carry
an unchanged signed envelope version 2, plus these server-authoritative fields:

| Field | Meaning |
| --- | --- |
| `delivery_policy` | `legacy` or `recipient-opening` |
| `created_at` | Acceptance time, integer Unix milliseconds |
| `opened_at` | First recipient opening time, integer Unix milliseconds, or `null` |
| `expires_at` | Effective deadline, integer Unix milliseconds |

`ttl` remains the signed lifetime in seconds. These metadata fields are outside
the signature. Shared `verifyDeliveredMessage` verifies the original signature
and validates the policy/deadline relationship. Both clients use that validator.
For legacy deliveries, opening stays null and expiry remains acceptance + TTL.
For recipient-opening deliveries, unopened expiry is acceptance + 86,400,000 ms;
opening before that deadline sets expiry to opening + the full signed TTL.
Opening can shorten or extend the previous unopened deadline. Availability ends
at `now >= expires_at`. GET and SSE delivery alone never open messages.

The additive lifecycle migration is transactional and repeatable. It marks
existing authenticated messages legacy without changing their envelope or deadline.
It is separate from the historical unauthenticated-envelope cutover.

## Opening

`POST /api/messages/:counterparty/open`, authenticated by the recipient's bearer
session, accepts exactly `{ "ids": ["0x…"] }`. IDs are canonical lowercase
16-byte hex message IDs. Supply 1–100 distinct IDs from one conversation.
The body limit is 8192 bytes (8 KiB), including streamed bodies. Limits are 120 requests
per minute per recipient and 240 per minute per IP, independently of sending.
Malformed requests return 400, oversized bodies 413, missing/invalid sessions
401, and rate-limited requests 429.

A valid request returns 200:

```json
{
  "server_time": 2000,
  "results": [
    {
      "id": "0x11111111111111111111111111111111",
      "status": "available",
      "delivery_policy": "recipient-opening",
      "created_at": 1000,
      "opened_at": 2000,
      "expires_at": 7000
    },
    { "id": "0x22222222222222222222222222222222", "status": "unavailable" }
  ]
}
```

Results preserve request order. Absent, expired, wrong-conversation and
non-recipient IDs all return the same unavailable shape. Available legacy and
already-opened IDs confirm the existing deadline. A write transaction acquires
the lock before sampling server time and checking availability, so concurrent
openings and lost-response retries cannot restart lifetimes. Retries after
expiry return unavailable. The server authenticates the recipient; it cannot
prove decryption or human attention.

## Expiry events and capability detection

Each first opening publishes SSE `expiry-update` to both participants after
commit. Its payload contains exactly `id`, `sender`, `recipient`, and the four
lifecycle fields above. It contains no ciphertext, signature or plaintext.
Legacy confirmations and retries do not publish another update. Clients must
refresh authoritative state after a lost stream; SSE is not a durable event log.

Clients advertise `X-0xChat-Delivery-Capability: recipient-opening-v1` on
requests; the browser and CLI send it on every request. `advertisesDeliveryCapability`
detects that exact value independently of signed-envelope version. SSE token
minting captures it; stream admission inherits the token's captured capability,
never a query-string override. The release gate below decides whether a missing
capability is rejected. Token expiry, single use and connection caps still apply.

## Release gate

Issue #81. Set `RECIPIENT_OPENING=1` (or `true`) to activate the lifecycle. New-policy
acceptance and compatibility enforcement switch on together:

- New messages are stored as `recipient-opening`.
- Send, conversation read, conversation list, open, state, recover and SSE token
  requests without the capability return 426
  `{ "error": "This 0xChat client is out of date. Reload the page or update the CLI.", "code": "client_update_required" }`.
  The check follows authentication, so a missing session is still 401.
- Stream admission refuses tokens minted before the latest activation with 401,
  so updated clients mint again. Activation closes live streams admitted without
  the capability before any new-policy message can be published.
- Push subscription management, session removal, registration removal,
  registration and authentication stay open to every client. Old clients can
  still remove notification subscriptions, and identity export is local.

The browser and CLI stop their ordinary retry loops on `client_update_required`.
The browser stops reconnecting its live stream and shows a "Reload to update"
action. That action fetches the newest service worker before reloading. Service
worker cache version `v3` deletes app shells cached before this release, so a
cached old client cannot boot again offline. Old browser tabs that predate the
gate display the error text, which tells users to reload.

Push notification deadlines still use the signed lifetime; retention-based push
scheduling is issue #91.

### Staged enablement

1. Deploy this server with `RECIPIENT_OPENING` unset. Production behavior is
   unchanged: every client is admitted and new messages are `legacy`.
2. Deploy the rebuilt browser bundle and publish the updated CLI. Both advertise
   the capability and interpret both policies. Refresh existing browser tabs.
3. Restart with `RECIPIENT_OPENING=1`. Older clients are now told to update.

### Rollback

Unsetting `RECIPIENT_OPENING` and restarting makes future messages `legacy`
again. Existing `recipient-opening` messages keep their lifecycle. Dual-policy
reads, opening and compatibility enforcement stay active while any unexpired
`recipient-opening` message remains. Enforcement is derived from stored
messages, so it survives restarts without separate gate state. Once the last
new-policy message expires, old clients are admitted again. Never roll back to
a server build that predates the lifecycle migration: it cannot interpret stored
lifecycle data.

## Isolated validation

`createFetch({ lifecycleGate: new LifecycleGate(true) })` activates the gate for
a test server; `LifecycleGate.activate()` activates it at runtime. Without a
gate, `createFetch()` reads `RECIPIENT_OPENING`. Tests explicitly initialize an
in-memory or temporary SQLite database.
Do not run `bun run test` in the working checkout: it deletes `chat.db` and
`dist`. Run that full command from an isolated copy with its own database.

Recovery and read-only lifecycle refresh are now documented in
[message-recovery-api.md](message-recovery-api.md) (issue #76).

Issue #75 changed neither push TTLs nor the push endpoint allowlist; browser
reveal is described below. Deploy the rebuilt
frontend alongside the server and refresh existing browser tabs so they load the
updated shared delivery validator. Older strict delivery validators reject the
added fields even though the signed-envelope version is unchanged. There are no
production CLI clients, so CLI compatibility does not block this deployment.

## Browser opening and reveal

Issue #77. The browser verifies and decrypts every delivery, then requests
opening only for incoming messages loaded in the selected conversation while
the document is visible and the window focused. Eligibility is checked again
after decryption, immediately before the request; sender copies never open.
The initial page, live SSE messages and older pages follow the same rule,
unloaded history stays unopened, and each request carries at most 100 IDs.
Queued requests retain their identity, conversation and session generation;
switching scope prevents older queued work from consuming the new scope's IDs.

Incoming plaintext of either delivery policy appears only after its ID is
confirmed available with a final deadline that has not passed. A confirmation
that lands after the window lost focus waits until the window is attentive
again. Unavailable IDs are removed; failed, missing or invalid confirmations
stay hidden behind a retry notice. Only confirmed openings and the identity's
own messages advance a conversation's unread marker.

Expiry updates merge forward: opened state replaces unopened state, final
deadlines never change, and removed IDs cannot return. One timer tracks the
earliest deadline; renders and regained attention re-check expiry. While the
stream is down, unopened recipient-opening messages, including sender copies,
are hidden but retained, even past their old unopened deadline. After the
stream reopens, a complete `state` lookup of the loaded IDs on that connection
restores them; an open transport alone does not. #80 replaces this refresh
with interval recovery and focus-driven message reconciliation.

Initial loaded state also receives a lifecycle lookup to establish server time.
Expiry uses that time plus elapsed monotonic time, conservatively including
request latency, so changing the device's wall clock cannot extend visibility.
Refresh results must match the message's policy, acceptance time and any final
deadline already known. If messages keep arriving through the bounded refresh,
the browser stays out of sync and offers retry instead of revealing unchecked
state.

`src/client/components/ChatView.test.tsx` mounts the conversation view with
happy-dom against an in-process test server that uses the new policy.
