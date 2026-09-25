# Owned notification slots (#82)

All operations require the identity's bearer session; addresses are normalized.
IDs are opaque identifiers, not credentials. Endpoint URLs never authorize a transfer.

## Contract

- `GET /api/push/subscriptions`: `{slots, revocations}` for this identity only.
  Slots expose `slot_id`, `installation_id`, `revision`, `label` (server-supplied
  `Browser`), `state` (`active` or `repair_needed`), `created_at`, `updated_at`.
  Revocations expose only the three identifiers/revision. No endpoints or keys.
- `POST /api/push/subscribe`: explicit enable, body
  `{installation_id, expected_revision, slot_id?, subscription: {endpoint, keys}}`.
  New installation: revision `0`, omit slot ID. Existing slot or revocation:
  send its ID and latest revision. Returns `{slot_id, installation_id, revision}`.
  Only a fresh explicit enable with the current revocation revision supersedes it.
- `POST /api/push/reconcile`: same body, slot ID required. Never creates or
  supersedes revocation. Confirms an unchanged live binding, or atomically replaces
  an owned slot's endpoint and keys when its expected revision matches. Both
  increment the revision. Replacement
  retains the slot ID, restores it to `active`, and is
  allowed at or above the five-slot cap. A destination owned by another slot fails
  with `ownership_conflict`. Quarantined legacy reservations cannot be replaced;
  remove them explicitly before enabling again.
- `POST /api/push/unsubscribe`: `{slot_id, installation_id, expected_revision}`.
  Deletes endpoint/key data and records revision + 1 atomically. Returns the
  revocation handle. Repeating the accepted removal is idempotent; older writes fail.

Every creation, adoption, removal and replacement is serialized by an SQLite immediate transaction. New slots start at revision 1. Legacy adoption
increments its revision. Confirmations of an unchanged binding increment it too,
so a removal or write sent before a confirmation cannot match afterwards;
pending wake-ups move to the new revision. Provider
404/410 clears endpoint/key data, retains the slot, and increments its revision;
completion is conditional on the attempted ID/revision. All retained slots,
including repair-needed slots, count toward five. Legacy excess is preserved.

Migration discards legacy subscriptions whose registration was already removed.
For retained registrations, it assigns IDs and placeholder installation IDs,
preserves keys/timestamps and canonicalizes endpoint destinations (host casing,
default ports, dot segments, and ignored userinfo/fragments). Ownership checks
and provider delivery use that same canonical URL. New requests still reject
userinfo/fragments; the supported-provider allowlist is unchanged.

If several legacy URLs resolve to one destination, every affected slot is
preserved as `repair_needed`, including its endpoint reservation and keys. None
is delivered or adopted, even when all belong to the same identity. No owner is
chosen implicitly. Every reservation must be explicitly removed before that
destination can be enabled again. Removal uses each owner's authenticated
list/unsubscribe API; full management UI remains in #83. These quarantined
reservations count toward the cap and survive restart. Unlike confirmed-dead
endpoints, their destination remains reserved until removal or registration
cleanup. Active destinations have a unique index; conditional enable checks all
reservations, including quarantined ones, inside its immediate transaction.

An authenticated explicit enable with a matching canonical endpoint can adopt
an unclaimed, active legacy slot into its installation at expected revision 0,
even above the cap. Adoption persists the submitted validated keys and increments
the slot revision atomically. Other identities cannot adopt it. Once claimed,
normal ID/revision rules apply. Re-running migration is harmless.

## Errors and limits

Errors use `{error, code}`. `ownership_conflict` (409) asks the old identity to
remove its binding; `slot_cap` (409) asks to remove an old subscription;
`revoked` (409) requires fresh explicit enabling; `revision_conflict` (409)
requires refreshing state; `repair_needed` (409) requires explicit recovery;
`registration_required` (409) requires registering again. Unknown ownership
returns repair-needed without revealing another identity's slot.
`invalid_request` (400), `unsupported_push_service` (400), `unauthorized` (401),
`rate_limited` (429), `payload_too_large` (413) cover transport/validation errors.
Mutations share 10/min per IP + identity and accept at most 8 KiB.

The browser persists installation and slot/revision per normalized identity.
On explicit enable it reads current owned state before issuing a conditional
write; it never automatically retries conflicts. Disable remembers off before
cleanup; failed cleanup is reported and its handle retained for retry. Session
start only reads status, never uploads or repairs. Legacy clients must update
before enabling; endpoint-only removal is rejected, not treated as authority.

## Durable wake-up dispatch

Message acceptance stores one content-free wake-up per active slot in the same
transaction as the message. Work records contain only slot/revision ownership,
a generation, the legacy message deadline, attempt count, due time, and optional
provider not-before time. They contain no message ID, ciphertext, conversation
hint, session token, endpoint, or push key. Multiple accepted messages coalesce
per slot while preserving newer in-flight generations and the latest applicable
deadline.

The dispatcher sends an empty payload with the remaining lifetime floored to
whole seconds. Work with less than one second remaining is discarded. Delivery
has bounded concurrency, one in-flight attempt per slot, and a finite provider
wait. A leased SQLite claim serializes attempts across server processes; the
transport is aborted at an absolute deadline, not merely on socket inactivity.
Provider response bodies are discarded after reading the status. Injected adapters
must honor the abort signal and settle after cancellation; a non-conforming adapter
retains local ownership rather than permitting overlapping attempts. Any live
terminal stream or attentive browser stream for the identity suppresses and
consumes the observed generation, reclaiming
an expired lease first when recovering work after restart. The
service worker retains its generic `0xchat-message` notification tag.

Pending work survives restart and respects stored due/provider times. Provider
acceptance followed by a crash before local completion can therefore deliver
again: dispatch is intentionally at-least-once for ambiguous outcomes, not
exactly-once. This slice makes one bounded attempt during normal operation;
#89 adds durable retry/backoff policy and #90 adds paused failure states.

Registration pruning/deletion and slot removal clear associated work
transactionally. Session expiry/revocation leaves slots and work intact. Same-slot
replacement transfers still-valid work to the new revision and fences stale
completion.

## Cross-tab coordination (#84)

Every tab of the origin shares one browser subscription and one installation ID,
so subscription mutations are routed through an origin-wide coordinator on top of
the existing per-hook queue and generation.

- Each mutation claims a shared generation in `localStorage` when it is requested,
  before any lock is awaited, and runs its side effects while holding one
  exclusive Web Lock. Concurrent tabs therefore take turns; the newest claim
  supersedes older operations wherever they are queued or already running.
- A completed mutation is broadcast on a `BroadcastChannel`. Other tabs answer it
  by re-reading actual browser and server state; `subscribed` is only ever derived
  from that read, never from the tab's own last action.
- The reads that gate a conditional write — the slot listing behind every
  enable, removal and superseded cleanup — now run inside the lock, so they
  reflect state no concurrent tab can still be rewriting.
- A superseded operation may not upload, mark enabled, or delete state it no
  longer owns. Under the exclusive lock, it re-lists slots and compares the
  authoritative revision before removing the slot it wrote. When its own write
  never landed, it leaves any active slot for this installation — and the browser
  subscription behind it — untouched, and it drops that browser subscription
  only under the lock. Every accepted write advances the revision, so a newer
  tab's write never leaves an older one matching. Without the lock, superseded
  cleanup still stands down once another tab has claimed: it leaves both
  artifacts alone and surfaces a conflict; it also cannot overwrite a newer
  tab's saved enable preference.
  A local generation alone never rejects a server request already in flight.
- Explicit actions surface a conflict (`COORDINATION_CONFLICT`) without marking
  notifications enabled; authoritative state converges through the re-read.
- Automatic mutation is refused with actionable recovery when the browser has no
  Web Locks or no shared storage, so competing owners cannot arise. Explicit
  actions still run there, serialized within the tab and fenced by the server's
  conditional writes.

Every enable, disable and slot removal is bounded to 30 seconds from the
moment it is requested, covering queueing, lock waiting, service-worker
readiness and browser/server calls, but not time spent answering the permission
prompt. Expiry releases the caller with an actionable error and makes the
operation stale, so a late result cannot upload, mark enabled, or delete a newer
binding. It cannot cancel the browser's promise, so the lock stays held until
that promise settles and the tab then re-reads actual state; other tabs'
actions wait meanwhile and time out themselves.

A reload drops the page's lock, so the native calls themselves (`subscribe`,
`getSubscription`, `unsubscribe`) run in the service worker, which outlives the
page. The worker makes them one at a time under its own Web Lock (or an
in-worker queue without Web Locks), so a call started by a closed tab keeps
every later call waiting until the browser actually settles it; no elapsed-time
grace period stands in for settlement. Each request carries its page's
remaining budget, and the worker never starts one still queued when that runs
out, including late cleanup from a timed-out operation. It removes only the
subscription endpoint the page saw, and announces each settled removal to every
tab so they re-read state. Server requests a reloaded page already sent are
fenced by revisions: re-enabling advances the slot revision even when the
subscription is unchanged, so a removal that lands afterwards fails instead of
revoking the newer binding. Automatic repair remains disabled.
