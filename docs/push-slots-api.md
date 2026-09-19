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
  supersedes revocation. Confirms an unchanged live binding; endpoint/key changes
  and dead slots return `repair_needed` (replacement is #83).
- `POST /api/push/unsubscribe`: `{slot_id, installation_id, expected_revision}`.
  Deletes endpoint/key data and records revision + 1 atomically. Returns the
  revocation handle. Repeating the accepted removal is idempotent; older writes fail.

Every creation, adoption, removal and future replacement is serialized by an
SQLite immediate transaction. New slots start at revision 1. Legacy adoption
increments its revision. Unchanged confirmations do not increment it. Provider
404/410 clears endpoint/key data, retains the slot, and increments its revision;
completion is conditional on the attempted ID/revision. All retained slots,
including repair-needed slots, count toward five. Legacy excess is preserved.

Migration assigns IDs and placeholder installation IDs to legacy rows without
changing their endpoint/keys/timestamps. An authenticated explicit enable with
matching endpoint can adopt an unclaimed legacy slot into its installation at
revision 0, even above the cap. Other identities cannot adopt it. Once claimed,
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

Registration pruning/deletion clears both slots and revocations transactionally.
Session expiry/revocation leaves both intact. No retry scheduler exists yet;
#88 must add retry cleanup to these same transactions. #83 owns same-slot
replacement and management UI; #84 owns cross-tab coordination. Automatic repair
stays disabled until its coordinator lands.
