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
  an owned slot's endpoint and keys when its expected revision matches. Replacement
  retains the slot ID, increments its revision, restores it to `active`, and is
  allowed at or above the five-slot cap. A destination owned by another slot fails
  with `ownership_conflict`.
- `POST /api/push/unsubscribe`: `{slot_id, installation_id, expected_revision}`.
  Deletes endpoint/key data and records revision + 1 atomically. Returns the
  revocation handle. Repeating the accepted removal is idempotent; older writes fail.

Every creation, adoption, removal and replacement is serialized by an SQLite immediate transaction. New slots start at revision 1. Legacy adoption
increments its revision. Unchanged confirmations do not increment it. Provider
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
provider receives the same finite request timeout, and a non-conforming adapter
that outlives it retains local ownership until it actually settles. Any live SSE
stream for the identity suppresses and consumes the observed generation. The
service worker retains its generic `0xchat-message` notification tag.

Pending work survives restart and respects stored due/provider times. Provider
acceptance followed by a crash before local completion can therefore deliver
again: dispatch is intentionally at-least-once for ambiguous outcomes, not
exactly-once. This slice makes one bounded attempt during normal operation;
#89 adds durable retry/backoff policy and #90 adds paused failure states.

Registration pruning/deletion and slot removal clear associated work
transactionally. Session expiry/revocation leaves slots and work intact. Same-slot
replacement transfers still-valid work to the new revision and fences stale
completion. #84 owns cross-tab coordination. Automatic repair stays disabled
until its coordinator lands.
