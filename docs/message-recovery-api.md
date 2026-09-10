# Message recovery and lifecycle lookup

Issue #76 adds authenticated conversation recovery alongside the existing
[delivery and opening contract](message-opening-api.md). All operations use the
participant's bearer session. Neither history, recovery, nor state lookup opens
messages. Signed envelopes and delivery metadata retain their existing shape;
no sequence or cursor is added to SSE deliveries or sender signatures.

## Establish a checkpoint

`GET /api/messages/:counterparty` still supports `limit`, `before`, and
`before_rowid` and returns the same `messages`, `next_before`, and
`next_before_rowid`. It additionally returns an opaque `recovery_cursor`.
History and this checkpoint are captured in one SQLite snapshot. For a new
conversation view, establish SSE first and buffer events, then load the normal
initial page and retain its checkpoint. Older unloaded history remains accessible
through the existing backward pagination; establishing a checkpoint does not
load or open that history. Do not replace an existing checkpoint when fetching
older pages: use completed recovery to advance it.

The checkpoint represents the server's acceptance high-water mark at that
snapshot, including when no messages remain. It is not the last message's ID,
timestamp, or implicit SQLite rowid. Clients must treat cursors as opaque.

## Recover a bounded interval

Start with `GET /api/messages/:counterparty/recover?after=<recovery_cursor>`.
The server captures an inclusive upper acceptance bound; the supplied checkpoint
is the exclusive lower bound. This returns up to 100 currently available messages
in ascending acceptance order:

```json
{
  "messages": [],
  "server_time": 2000,
  "exhausted": true,
  "next_cursor": null,
  "recovery_cursor": "opaque-completed-checkpoint"
}
```

When `exhausted` is false, `next_cursor` is an opaque continuation token and
`recovery_cursor` is null. Continue with
`GET /api/messages/:counterparty/recover?cursor=<next_cursor>` until exhausted.
Only an exhausted response supplies the new completed checkpoint. Exactly one
`after` or `cursor` parameter is required; other or repeated parameters are
rejected. Page size is fixed at at most 100.

Continuation tokens preserve the original upper bound. They advance past the
last returned acceptance sequence without requiring that message to still
exist. Expired/deleted boundaries and even an entirely expired remaining page
are valid: an empty exhausted page still yields a completed checkpoint. New
acceptance beyond the upper bound belongs to buffered live events or a later
recovery. A page observes current availability and lifecycle state; replaying a
request may return fewer messages or updated deadlines. Retrying `after` starts
a fresh interval with a newly captured bound; retrying `cursor` retains its bound.

Tokens are authenticated by a database-persisted key and scoped to the requesting
identity and conversation. They survive session renewal and process restart,
but not database replacement. No session token is embedded in them. Missing or
invalid sessions return 401; malformed, forged, wrong-kind, wrong-identity, or
wrong-conversation cursors return 400. There is no client-supplied numeric upper
bound. Keep the prior completed checkpoint until all pages have been merged by
message ID. Never infer gap completion from the largest live sequence or from a
new history response. Browser orchestration is tracked separately in #80.

## Refresh loaded lifecycle state

`POST /api/messages/:counterparty/state` accepts exactly `{ "ids": ["0x…"] }`:
1–100 distinct canonical lowercase 16-byte hex IDs. The response has the same
`server_time` and ordered `results` shape as opening:

```json
{
  "server_time": 2000,
  "results": [
    {
      "id": "0x11111111111111111111111111111111",
      "status": "available",
      "delivery_policy": "recipient-opening",
      "created_at": 1000,
      "opened_at": null,
      "expires_at": 86401000
    },
    { "id": "0x22222222222222222222222222222222", "status": "unavailable" }
  ]
}
```

Both participants can query either direction in their conversation. Missing,
expired, deleted, other-conversation, and other-identity IDs produce identical
unavailable results. The operation reads a consistent snapshot and never changes
opening/deadline state or emits expiry updates. No ciphertext is returned.

Malformed requests return 400; bodies over 8192 bytes, including streamed bodies,
return 413. The independent lookup budget is 120 requests/minute per identity
and 240/minute per IP; exceeding it returns 429. Authentication failures return
401. Lookup consumes neither the sending nor opening budget.

## Persistence and validation

A transactional, repeatable migration backfills acceptance sequence in existing
`(created_at, rowid)` order while preserving message IDs, envelopes, deadlines,
and rowids used by older-page cursors. New insertion atomically advances a
persisted high-water mark, which deletion never lowers. The cursor key is also
persisted. Legacy delivery and existing SSE/Web Push behavior remain unchanged.

Real HTTP/SQLite tests cover equal timestamps, intervals over 100, concurrent
sends beyond a captured bound, expired/deleted boundaries, deleting all rows
then inserting after restart, repeat migration, old pagination cursors,
authorization, state limits, and read-only deadline refresh. Run the full
`bun run test` only in an isolated copy: it deletes the working directory's
`chat.db` and `dist`. No browser recovery orchestration is included here.
