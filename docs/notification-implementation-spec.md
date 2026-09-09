# Reliable notifications and opening-based message expiry

Status: synthesized implementation spec. Synthesized on 2026-09-09 from the
accepted implementation decisions Q1–Q20 and the agreed domain behavior, with
the current implementation checked at commit `1c961ad` plus the working-tree
decision documents. Dependent implementation tickets require a separate
breakdown review before publication.

Published as [GitHub issue #73](https://github.com/endziu/0xchat/issues/73).

## Problem Statement

An offline recipient can miss a notification because its delivery window is
currently only the sender-selected message lifetime. A five-second message can
disappear before the recipient gets an opportunity to open it. Conversely,
extending the notification window alone would advertise messages already deleted
by the server.

Browser live connections remain active in the background, reconnects do not
recover the full missed-message gap, and the current message refresh replaces
loaded history. Push subscription recovery can stall or fail after key rotation;
endpoint ownership, pruning, and delivery failures lack the lifecycle guarantees
needed across identities, tabs, devices, and server restarts.

Recipients need a consistent opportunity to open messages, reliable generic
notifications when live delivery is unavailable, and understandable controls
when notifications need repair. Both participants need consistent expiry across
the browser and terminal clients.

## Solution

Keep SSE for live delivery and content-free Web Push for background alerts.
New messages wait unopened for at most 24 hours. The recipient's first
server-confirmed opening starts the full sender-selected lifetime. Successfully
verified and decrypted incoming plaintext is revealed only after that opening
is confirmed. Existing messages retain their original deadlines.

A browser opens messages only in a selected conversation in a visible, focused
window. The terminal's consuming commands explicitly open their messages.
Browser reconnection restores missed messages and authoritative expiry state
without discarding loaded history. A live SSE connection anywhere for the
recipient suppresses new push attempts for that identity.

Notification opt-in remains explicit for a new identity and survives reloads for
the same identity. Recovery respects ownership, deliberate disabling, and remote
removal. Temporary delivery failures retry durably; authentication and
configuration failures pause until repaired. Settings allow removal of old
subscriptions within a five-subscription limit.

## User Stories

1. As a recipient, I want an unopened message retained for up to 24 hours, so that a short message lifetime does not remove my opportunity to open it.
2. As a recipient, I want the full sender-selected lifetime after opening, so that opening late does not shorten the time available to read.
3. As a sender, I want my selected lifetime respected after recipient opening, so that the message's availability follows the agreed behavior.
4. As a browser recipient, I want background tabs and unfocused windows not to open messages, so that unattended activity does not start their lifetimes.
5. As a recipient, I want only successfully loaded messages opened, so that unloaded history remains available until I load it or its retention limit passes.
6. As a recipient, I want invalid or undecryptable messages rejected without opening them, so that failed processing does not consume their lifetime.
7. As a recipient, I want acknowledgement failure to leave incoming plaintext hidden with a retry action, so that reading and opening stay consistent.
8. As a recipient, I want acknowledgement retries to recover the same deadline, so that a lost response does not extend or restart a lifetime.
9. As an identity using multiple devices, I want one authoritative deadline per message, so that devices agree on availability.
10. As a participant, I want expiry changes applied to my already-loaded messages, so that stale timers do not delete them early or display them too long.
11. As a participant, I want messages already stored at rollout to retain their original deadlines, so that upgrading does not change their retention.
12. As a browser participant, I want changeable deadlines refreshed before content reappears after a synchronization gap, so that another device's opening is respected.
13. As a browser participant, I want messages with confirmed final deadlines to remain available until those deadlines during a disconnection, so that known availability is preserved.
14. As a terminal recipient, I want read, watch, and chat to open the incoming messages they consume, so that their behavior is explicit even for background or piped consumption where supported.
15. As a terminal participant, I want listing conversations to leave messages unopened, so that checking activity does not consume their lifetime.
16. As a terminal participant, I want expiry updates without duplicate message output, so that live conversations and scripts remain understandable.
17. As a participant with an older client, I want a clear update-required error, so that I can recover from a protocol transition.
18. As an offline recipient, I want notification delivery to use the remaining unopened retention window, so that a short lifetime can still generate an alert hours later.
19. As a recipient using live delivery, I want push attempts suppressed across my identity while an SSE connection is live, so that foreground activity avoids unnecessary OS alerts.
20. As a browser participant, I want SSE to reconnect when my window becomes visible and focused, so that background connections do not indefinitely suppress push.
21. As a browser participant, I want all still-available missed messages recovered, even beyond 50 messages, so that reconnecting does not silently omit a gap.
22. As a browser participant, I want loaded history and scroll position preserved during recovery, so that reconnecting does not disrupt what I was reading.
23. As a browser participant, I want incoming messages during recovery merged without loss or duplication, so that live delivery and recovery cooperate.
24. As a browser recipient, I want unread state to respect opening conditions and confirmation, so that a selected background conversation is not silently treated as read.
25. As an identity enabling notifications, I want my endpoint bound only to my authenticated identity, so that another identity cannot take over its registration.
26. As an identity switching keys, I want switching to finish even when old notification cleanup fails, so that a failed browser operation does not trap me in the old identity.
27. As the newly selected identity, I want notifications kept off after cleanup failure until I explicitly enable them after recovery, so that a surviving endpoint is not silently transferred.
28. As a returning identity, I want previously enabled notifications repaired automatically when safe, so that ordinary visits recover subscription failures and key rotation.
29. As an identity that disabled notifications, I want that choice remembered on this browser, so that reloads do not enable them again.
30. As an identity whose browser requires interaction for repair, I want a Repair notifications action, so that I can complete recovery deliberately.
31. As an identity using several browsers, I want up to five subscriptions and a way to remove old ones remotely, so that unavailable devices do not prevent new setup.
32. As an identity at the subscription limit, I want an actionable rejection without silent eviction, so that working devices keep their notifications.
33. As an identity repairing an existing subscription, I want replacement to retain its slot, so that repair works at the limit.
34. As an identity removing an old subscription, I want that browser to require explicit enabling when it returns, so that automatic repair does not undo removal.
35. As a recipient, I want temporary push failures retried without another message, so that a single message still has another notification opportunity.
36. As a recipient, I want pending retries to survive a server restart, so that deployment does not lose the remaining attempt.
37. As an identity whose push delivery needs repair, I want an actionable paused state without losing opt-in, so that configuration failures do not silently disable my preference.
38. As a browser participant, I want notification setup to stop waiting after 30 seconds, excluding permission-prompt time, so that a stalled browser service does not block other actions.
39. As a browser participant using multiple tabs, I want stale or timed-out operations unable to overwrite newer subscription state, so that concurrent actions remain safe.
40. As a notification recipient, I want a generic alert whose click focuses an existing chat client without switching its conversation, so that alerts preserve privacy and my current context.
41. As an identity, I want service-worker recovery to keep credentials out of the worker, so that background recovery does not expand credential access.
42. As an operator, I want registration pruning and subscription removal to clear associated retry work, so that obsolete identities and devices stop consuming delivery resources.

## Implementation Decisions

The behavior below implements Q1–Q20 and decision #68. Details identified as
**synthesis choices** resolve the engineering questions left to the spec; they
are reviewable proposals rather than additional answers from the interview.

### 1. Preserve the architecture and authenticated envelope

- Retain the SSE token, reconnection backoff, connection-cap model, authenticated
  push binding, endpoint allowlist, and client queue/generation contract.
- Keep push payloads empty. Retry state contains no message content, ciphertext,
  conversation hints, session tokens, or identity keys.
- Keep signed-envelope versioning separate from delivery-lifecycle versioning.
  The sender-selected lifetime remains signed. Server-assigned acceptance,
  opening, and expiry metadata is delivery state, not a rewritten signature.
- Update shared delivery validation and both clients together. Preserve
  signature verification, participant checks, authenticated encryption, and
  rejection of malformed delivery metadata. The current delivery validator's
  acceptance-plus-lifetime equality remains valid only for legacy messages.

### 2. Store one authoritative message lifecycle

Persist an explicit expiry policy, acceptance time, optional opening time, and
effective expiry deadline alongside each message. Preserve the original
envelope and message ID. The unopened retention deadline is acceptance plus
24 hours and remains derivable after opening.

| Policy/state | Authoritative expiry | Allowed transition |
| --- | --- | --- |
| Legacy | Original stored deadline | Expired only; opening never extends it |
| New, unopened | Acceptance + 24 hours | First recipient opening before this deadline, or expiry |
| New, opened | First server-accepted opening + signed lifetime | Expired only |
| Expired/absent | Unavailable | No revival |

Opening just before the retention limit grants the full lifetime, even when its
final deadline falls beyond acceptance plus 24 hours. Opening can also shorten
availability relative to the unopened deadline. Neither participant's local
clock chooses the deadline. Treat `now >= deadline` as expired consistently in
reads, acknowledgements, cleanup, and client visibility.

Use an additive, transactional migration that marks existing messages legacy
without deleting them or changing ciphertext, signatures, or original
deadlines. Re-running migration is harmless. Do not use the current destructive
envelope-cutover pattern for this lifecycle migration.

### 3. Acknowledge opening before revealing incoming plaintext

**Synthesis choice:** add an authenticated batch opening operation, scoped to
one conversation, accepting at most 100 distinct message IDs. Return a result
per ID with authoritative lifecycle metadata or an unavailable result, plus
server time. Reject malformed requests; use indistinguishable unavailable
results for absent, expired, and non-recipient message IDs so the operation
does not expose other conversations. Apply bounded request/rate limits without
making normal history-page consumption exceed them.

- Clients verify and decrypt internally before requesting opening. Send only
  successfully processed incoming message IDs; sender copies never open a
  message. The server can authenticate the recipient but cannot prove actual
  decryption or human attention.
- Atomically check availability and perform the first unopened-to-opened
  transition using server time. Concurrent devices and duplicate requests
  receive the same resulting deadline. Retry after a lost response returns that
  deadline only while the message remains available.
- Acknowledging a legacy or already-opened incoming message confirms its
  existing deadline without changing it. This provides one confirmation path
  for loaded incoming messages under either policy.
- Reveal plaintext only after a successful confirmation and a fresh check that
  the deadline has not passed. Failed IDs remain hidden with a retryable error;
  successful IDs can be displayed independently. A missing message is removed,
  not retried as though it could be revived.
- Recheck identity, conversation generation, and browser opening conditions
  after asynchronous verification/decryption and before requesting opening.
  A request already sent while eligible may be accepted after focus is lost;
  it cannot be recalled. Do not reveal its plaintext while no longer eligible.
- Browser eligibility means selected conversation, visible document, and
  focused window. Loaded older pages follow the same rule; bubble visibility
  is irrelevant. Acknowledgement success, not selection alone, clears incoming
  unread state. Do not introduce a global server read-receipt product.
- Terminal read opens only its returned page(s). Watch and chat open consumed
  history and incoming messages while running, without a focus check. Preserve
  existing command restrictions: chat still requires an interactive terminal;
  read/watch support scripts. Conversation listing performs no opening.

### 4. Synchronize deadlines and recover the full browser gap

Publish an expiry-update SSE event to both participants after an opening
transaction commits. Include message ID, conversation identity information
needed by that participant, and authoritative lifecycle metadata, without
plaintext. Updates never cause duplicate terminal message output. Interactive
terminal rendering and de-duplication state must use the new deadline;
historical terminal output cannot be retracted. Terminal JSON streams may emit
a distinguishable metadata-only expiry event, never another plaintext copy.

**Synthesis choices for recovery:**

- Introduce a durable, non-reused acceptance sequence for message ordering and
  server-issued recovery cursors. Existing implicit SQLite row IDs must not be
  assumed to remain unique after deletion. Backfill a stable order preserving
  existing timestamp/tie ordering without changing message IDs or deadlines.
- Extend conversation reads with bounded forward recovery between an exclusive
  lower cursor and a server-captured inclusive upper cursor. Pagination is at
  most 100 messages per page, reports explicit exhaustion, and remains valid
  if boundary messages expire. New messages beyond the captured upper cursor
  belong to live delivery or the next recovery.
- Add an authenticated bounded state lookup for already-loaded message IDs,
  scoped to the conversation. Return lifecycle state or unavailable per ID.
  New-message pagination alone cannot refresh deadlines in older loaded history.
- Establish SSE first, buffer events during recovery, capture the recovery
  bound, refresh the conversation list, and page through the entire missed
  interval. Reconcile already-loaded IDs, then merge buffered events and
  recovered messages by ID. Retain loaded history, its older-page cursor, and
  a scroll anchor. If the anchor expired, retain the nearest surviving position.
- Track completion of a contiguous recovered interval, not simply the largest
  ID/sequence seen through SSE. A live message must not advance the recovery
  cursor past an unfetched gap. With no prior cursor, load the normal initial
  page; do not open all history merely to establish a cursor.
- Lifecycle state is monotonic: opened metadata wins over stale unopened
  metadata; a final deadline never changes; unavailable/expired messages cannot
  be resurrected by buffered events. Apply current-time expiry checks after
  merging and replace timers whenever deadlines change. Retain enough hidden
  state during a synchronization gap to reconcile a message whose old unopened
  deadline passed but may have been extended by another device's opening.
- Opening recovered messages follows the same successful-load, eligibility,
  verification, and acknowledgement rules. Unloaded history outside recovery
  remains unopened.

Close browser SSE on hidden-document or focus-loss events, including during
token minting or reconnect backoff. Reconnect only while visible and focused.
An open transport alone is not synchronized state: recovery must finish on the
current connection before changeable-deadline content can reappear. Disconnect,
recovery failure, identity change, or conversation change invalidates unfinished
work and prevents stale results from committing.

During intentional or accidental loss of synchronization, hide messages whose
deadline can still change, including the sender's unopened copies. Messages
with confirmed final deadlines may remain visible until those deadlines.
First-time incoming plaintext still requires opening confirmation. Re-evaluate
deadlines on focus/reconnect/render because background timers may run late.

### 5. Gate rollout across the server and both clients

**Synthesis choice:** use an explicit delivery-protocol capability independent
of the signed envelope. Updated clients advertise support on message operations
and SSE-token creation; the server records it on tokens and admitted streams.
When the lifecycle is enabled, reject incompatible message send/read and
conversation operations and token minting with a structured
`client_update_required` error and a clear update action. Admission must also
reject tokens minted before the gate, and activation must close incompatible
existing streams before publishing new-policy messages. Updated clients stop
normal retry loops on update-required errors. Identity export and notification
cleanup must remain accessible.

Roll out in this order:

1. Add preserved-data migration, dual-policy delivery contracts, opening/state
   operations, expiry events, and compatibility detection with the new policy
   disabled for acceptance.
2. Deliver browser and CLI support for both policies, acknowledgement-gated
   plaintext, deadline updates, and recovery. Upgrade app-shell assets so old
   cached clients have a usable reload/update path.
3. Activate the admission gate and new message policy together once the server
   and both supported clients are available. Older clients must update.
4. Use retention-based push deadlines for new-policy messages only after that
   activation. Notification fixes independent of expiry may ship earlier.

After activation, disabling new-policy acceptance may make future messages
legacy again, but dual-policy reading/opening and the compatibility gate must
remain while new-policy messages exist. Do not roll back to a server that
cannot interpret stored lifecycle data.

### 6. Own subscriptions, enforce the cap, and preserve revocation

Replace unconditional endpoint replacement with authenticated, conditional
ownership operations. Normalize identity addresses consistently. An endpoint
owned by another identity is rejected until its previous binding is explicitly
removed; possession of the endpoint URL is not authorization to transfer it.

**Synthesis choices:**

- Give each logical browser subscription an opaque server ID and revision,
  independent of its current endpoint. Associate it with an opaque browser
  installation identifier. These identifiers are not credentials; every
  operation requires the owning identity's session.
- Expose identity-scoped list, enable, reconcile/replace, and remove operations.
  List returns ID, safe browser label, timestamps, and delivery/repair state;
  do not display endpoint URLs, push keys, or unrelated identities.
- Distinguish explicit enabling from automatic reconciliation. Conditional
  writes carry the expected registration revision. Revocation increments that
  revision so late repair cannot restore a removed subscription.
- Preserve an identity-scoped revocation marker until the identity's
  registration is removed or a fresh explicit enable supersedes it. Revoked
  markers retain no endpoint or push-key material and consume no active slot.
  A returning browser with a revoked ID requires explicit enabling. Unknown
  ownership fails closed rather than treating local opt-in as server proof.
- Confirmed-dead endpoints and intentionally revoked subscriptions are distinct
  states. A dead endpoint may retain its owned logical slot for repair, without
  endpoint/key material or pending retries, until replaced or explicitly removed.
  Missing server state can be repaired automatically only when authenticated
  ownership can still be established; otherwise require explicit enabling.
- Enforce at most five non-revoked logical subscriptions per identity in a
  transaction, including paused or repair-needed slots. Reconcile the same slot
  without adding one. Replace endpoints atomically within the owned slot, with
  a global endpoint ownership check. Reject a sixth slot with an actionable
  limit error and settings access; never silently evict.
- Preserve existing bindings at migration. Establish ownership of a legacy
  binding from its authenticated owner and matching endpoint before assigning
  its logical slot. If an existing identity has more than five subscriptions,
  grandfather them without eviction, allow in-place repair/removal, and reject
  additions until below the cap.

Explicit removal invalidates the slot and deletes endpoint data and retry work
transactionally. Registration pruning and explicit registration deletion remove
all associated slots, revocation markers, and retry work transactionally.
Ordinary session expiration/revocation does not remove push subscriptions.
Rate-limit subscription mutations, including removal, and return structured,
actionable ownership, cap, revocation, and repair errors.

### 7. Repair opt-in without crossing identities or tabs

Remember notification preference per normalized identity on this browser.
Default a new identity to off. Disabling persists before attempting cleanup and
blocks future automatic repair, including after reload. On initial migration,
infer prior opt-in only from a surviving subscription whose owner the server
confirms; permission alone is insufficient.

For the same opted-in identity with granted permission and confirmed ownership,
reconcile automatically on session start, including VAPID mismatch replacement.
Remote revocation overrides remembered opt-in. If a gesture is required, stop
automatic attempts and offer **Repair notifications**. Missing permission or
unsupported services receive actionable guidance without repeated prompts.

Identity switching attempts old server and browser cleanup but completes if
either fails. Surface the failure, persist the unresolved cleanup state, and
leave notifications off for the new identity. Recovery may finish old cleanup;
it may not automatically enable the new identity or transfer a surviving
endpoint. If both cleanups fail, alerts for the old identity may continue until
cleanup succeeds; disclose this accepted limitation in the error.

**Synthesis choice:** coordinate browser subscription mutations across all tabs
for the origin, using a shared operation generation and an exclusive browser
lock where available. Broadcast state changes and re-read authoritative state
before committing. Keep the existing per-hook queue/generation protections.
If safe cross-tab serialization cannot be established, fail automatic mutation
with an actionable retry instead of allowing competing owners.

Bound automatic setup from enqueue to completion to 30 seconds, excluding time
spent answering a permission prompt. A timeout invalidates the operation,
releases the caller, reports an actionable error, and leaves identity switching
usable. It does not cancel an underlying browser promise.

Late completion must not upload, mark enabled, or delete a newer subscription.
Use server revision checks and browser operation ownership together; a local
generation alone cannot reject a server request already in flight. Cleanup
may remove only an artifact still demonstrably owned by that stale operation.
While an unresolved native mutation could affect a shared subscription, defer
conflicting subscription mutation and offer recovery without blocking identity
switching. Reconcile actual browser/server state after it settles. Persist
enough unresolved-operation state to handle reload and another tab taking over.

### 8. Deliver and retry one content-free wake-up per endpoint

At message acceptance, derive a notification deadline from policy:

- New lifecycle: acceptance + 24 hours, regardless of the signed lifetime or a
  later opening.
- Legacy: its original stored expiry deadline.

Every attempt uses only the remaining time to that deadline, never a new
24-hour window. **Synthesis choice:** floor remaining seconds for provider TTL
and discard work with less than one second remaining rather than sending
beyond its deadline.

Check identity-wide live SSE presence before initial delivery and every retry.
A live browser or terminal connection suppresses delivery to all the identity's
endpoints, even when it is viewing a different conversation. The browser focus
gate limits background suppression; background terminal consumers remain live.

**Synthesis choices for durable scheduling:**

- Persist one pending wake-up per active endpoint/slot, its ownership revision,
  deadline, work generation, attempt count, next-attempt time, and provider
  not-before time in SQLite before starting delivery. Run a bounded-concurrency
  dispatcher with one in-flight attempt per endpoint and finite network waits.
- Coalesce new work by retaining the latest applicable notification deadline
  and incrementing its work generation. Do not reset existing backoff,
  provider not-before time, or pause state. This generic wake-up can represent
  several messages and stores no message contents or IDs.
- Retry temporary failures after one minute, doubling to a one-hour cap. A
  longer valid provider-requested delay wins; persist the resulting due time.
  A subsequent message does not force an early attempt.
- On suppression, discard the observed pending generation, as initial-send
  suppression discards that message's wake-up opportunity. Do not park it for
  delivery after SSE closes. The accepted policy assumes identity-wide live
  delivery is sufficient; there is no per-device delivery receipt fallback.
- Completion removes only the generation actually attempted or suppressed.
  Newer work that arrived in flight remains pending. Failure applies the
  endpoint's updated backoff or pause to retained newer work as well.
- Removal/replacement/pruning invalidates work through ownership revisions;
  late completions cannot delete a replacement slot or create retries for it.
  Successful replacement may transfer still-valid pending work to the new
  endpoint under the same owned slot; it does not restart its deadline.
- Persist pause state and outstanding scheduling state across restart. Before
  resumed delivery, recheck deadline, registration existence, endpoint
  ownership/revision, and SSE presence. Expired work is removed even if paused.
  Do not replay a pending retry as an immediate attempt before its due time.
- Delivery is at-least-once across an ambiguous provider result or crash after
  provider acceptance but before local completion. Preserve the notification
  tag to coalesce visible alerts; do not promise exactly-once delivery.

An already-queued provider notification may arrive after another device opened
and expired the message. Opening does not cancel provider queues or shorten the
new-policy notification deadline; this is the accepted content-free-alert
trade-off. Removing an endpoint stops future server attempts but cannot retract
an attempt already accepted by a provider.

### 9. Classify failures and expose repair

**Synthesis choice:** use a small explicit delivery-result classification:

| Result | Action |
| --- | --- |
| Successful provider acceptance | Complete only the attempted work generation |
| Confirmed-dead endpoint, including 404/410 | Delete endpoint/key material and pending work; retain repairable ownership distinct from revocation |
| Network/timeout, 408, 429, or 5xx | Durable temporary retry with applicable provider delay |
| Authentication failure, including 401/403 | Persist delivery pause; preserve subscription and opt-in; surface repair |
| Missing/invalid VAPID configuration or other non-retryable request rejection | Pause affected delivery, expose an operator/client repair reason, and avoid repeated attempts |

Do not treat every error as temporary or discard opt-in on failure. Global
configuration failure pauses affected delivery globally; an endpoint-specific
failure pauses that slot. Expose safe status through authenticated settings and
operational diagnostics without logging endpoint secrets or message content.

Resume a slot after successful reconciliation appropriate to its failure, or
resume configuration-paused work after a verified configuration fix. A routine
message or reload alone does not clear a pause. Resume only still-valid work
and respect any outstanding provider delay. A key change requiring browser
replacement remains repair-needed until that replacement succeeds.

### 10. Keep service-worker behavior conservative

- On push, show the existing generic title, body, icon, badge, and tag. Do not
  inspect payload content or suppress an already-delivered push because a
  window became focused; foreground suppression happens before server sending.
- On click, close the clicked notification and deterministically choose an
  existing same-origin chat client: prefer focused, then visible, then a stable
  client-ID order. Focus without navigating or changing its active conversation.
  If none is usable, open the chat list at the fixed application route. Do not
  use arbitrary notification data as a navigation target.
- On pushsubscriptionchange, notify open application pages to reconcile through
  their authenticated subscription coordinator. Keep session tokens and
  identity keys out of the worker. With no page open, wait for the next visit.
  Session-start reconciliation remains the reliable recovery path.
- Preserve exclusion of API/SSE traffic and sensitive data from worker caches.
  Worker-event tests exercise production handlers; moving the worker or
  rewriting it in TypeScript is not required for this behavior.

## Testing Decisions

Use the four boundaries proposed in the readiness review and accepted when
proceeding with synthesis. Test observable behavior through the highest existing
public interface practical. Do not assert private helper call order or database
layout as a proxy for user behavior. Keep tests with each implementation slice.

### Server API, persistence, and SSE

Extend the existing real-HTTP messaging/SSE tests and signed-envelope
round-trip tests. Use real SQLite in an isolated temporary location. For
migration, seed a pre-upgrade database, restart through the actual initialization
path, then verify message availability and unchanged deadlines through the API.
For retry restart tests, stop and restart the server against the same temporary
database and observe outbound delivery rather than internal queue rows.

Cover:

- Recipient-only opening; bad signatures/decryption rejected by clients;
  unopened expiry at exactly 24 hours; opening immediately before expiry;
  five-second and 24-hour lifetimes; concurrent opening; lost acknowledgement;
  retry after expiry; partial batches; legacy preservation and repeat migration.
- Both participants receiving deadline changes; server filtering expired
  messages before periodic cleanup; stable pagination despite equal timestamps,
  expired boundaries, deletion, and new acceptance; state lookup authorization.
- Capability rejection on API calls, old token admission, and existing streams
  at activation; supported clients reading mixed policies without changing
  signatures; restart after activation preserving data.
- Ownership conflict; concurrent sixth-subscription attempts; repair at the
  cap; legacy over-cap migration; revocation winning against in-flight repair;
  identity-scoped list/removal; registration pruning versus session expiration.

### Browser and CLI behavior

Extend existing client API, SSE connection, identity-transition, and CLI
integration tests. Add browser behavior coverage at the mounted conversation
and notification-settings boundary, including their real orchestration rather
than only isolated queue helpers. Use controllable transport/browser adapters
where platform events need deterministic timing.

Cover hidden/unfocused selection, focus changes during decryption and
acknowledgement, incoming plaintext withheld until confirmation, retryable
failure, unloaded versus loaded history, unread state, and already-final
deadlines during disconnection. Recover a gap exceeding 100 messages while live
messages and expiry updates arrive; preserve earlier loaded history and scroll
position; reject stale responses after identity/conversation changes. Exercise
an opening that extends availability past the old unopened deadline.

For CLI, verify read/page/all-history consumption, background watch, interactive
chat, no opening from conversation listing, retry errors without plaintext
leakage, expiry-update processing, and no duplicate plaintext in text or JSON
output. Preserve terminal sanitization and existing TTY restrictions.

### Subscription lifecycle across tabs

Build on existing subscription operation, permission, queue/generation, and
identity-transition tests. Observe server binding and visible settings state
through the coordinator's public actions and browser entry points.

Cover same-identity repair and VAPID rotation, disabled preference across reload,
new-identity explicit enabling, revoked versus dead/missing registrations,
gesture-required repair, partial cleanup failures, two-tab enable/remove/switch
races, and server writes completing after supersession. Advance a controlled
clock through the 30-second timeout and then resolve each outstanding browser
operation; verify it cannot enable or remove a newer registration. Include a
stalled service-worker-ready promise and permission time excluded from timeout.

### Push transport and service-worker events

Use a fake provider at the outbound Web Push boundary, with controllable results,
delays, and a clock, while retaining real scheduling/persistence behavior.
Assert empty payloads, remaining TTL, fan-out, endpoint isolation, all failure
classes, backoff and longer provider delays, coalescing, in-flight new work,
suppression disposal, pause persistence/resumption, pruning, and restart.

Run production worker handlers against a minimal worker-event/browser-client
harness to verify generic visible notification options, deterministic safe
click behavior, page reconciliation messages, no authenticated worker requests,
and continued cache exclusions.

Keep real-device smoke checks separate from deterministic automation. Use a
production build over HTTPS to check permission, background delivery, focus,
installation, clicks, and repair on the supported browser/device cases in the
capability matrix, including installed iOS where available. Record versions and
results; simulations do not establish real push-service or OS behavior.

Implementation completion requires the repository typecheck, lint, and full test
suite plus recorded applicable device checks or explicit unverified cases. Run
the destructive full test command only in an isolated checkout/database context.
This documentation-only synthesis does not claim those behavioral tests exist
or pass yet.

## Out of Scope

- Replacing SSE/Web Push, native applications, direct APNs, or Declarative Web
  Push work.
- Notification payload content, conversation-specific click routing, sender
  identity previews, or per-device suppression/delivery receipts.
- Guaranteed notification arrival, exactly-once provider delivery, background
  repair with no application page, or bypassing platform permission/install
  restrictions.
- Retroactive lifetime extensions for legacy messages; opening unloaded
  history; restarting a lifetime; reviving expired messages.
- Retraction of terminal logs, copied plaintext, or notifications already
  accepted by a provider; cryptographic enforcement of human attention.
- An unrelated worker-language rewrite, general UI redesign, or changes to the
  established endpoint allowlist without separate evidence.
- Publishing dependent implementation tickets as part of spec synthesis.

## Further Notes

Sources of accepted behavior:

- Notification implementation decisions, Q1–Q20, in the working-tree document
  `docs/notification-implementation-decisions.md` at synthesis time.
- Agreed domain behavior in the working-tree document `docs/domain-behavior.md`
  at synthesis time. These local source revisions are not yet committed; this
  spec includes the resulting behavior without requiring those links to resolve.
- [Locked architecture and eight priorities in #68](https://github.com/endziu/0xchat/issues/68#issuecomment-5571571314).
- [Notification review](https://github.com/endziu/0xchat/blob/1c961ad/docs/research/notification-review.md) and
  [capability matrix](https://github.com/endziu/0xchat/blob/1c961ad/docs/research/push-capability-matrix.md), used as baseline
  research rather than a claim that their earlier test counts describe today.

Traceability: Q1/Q5/Q7/Q19 map to lifecycle, migration, and rollout; Q2–Q6 and
Q20 to opening and client synchronization; Q8 to notification deadlines;
Q9–Q10 to SSE gating/recovery; Q11–Q13/Q15/Q18 to subscription ownership,
repair, coordination, and worker recovery; Q14/Q16–Q17 to durable delivery.
The retained notification surface and pruning also preserve #68 priorities.

For the later ticket breakdown, lifecycle activation depends on compatible
server, browser, and CLI behavior, and retention-based push TTL depends on that
activation. Subscription repair depends on authoritative ownership/revocation
and slot replacement. Durable retries depend on subscription lifecycle and
persisted delivery state. Focus gating should ship with gap recovery and safe
out-of-sync visibility. Worker presentation tests and independent cleanup fixes
can proceed without waiting for lifecycle activation.

The next step is a reviewable ticket breakdown with acceptance criteria and
explicit dependencies. Review that breakdown before publishing its GitHub
tickets, as requested in the decision record. The synthesis choices above
should be reviewed with this spec rather than treated as previously confirmed
interview answers.
