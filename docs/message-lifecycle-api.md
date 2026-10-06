# Message lifecycle API

How the server reports, opens, recovers and looks up message lifetimes. The
agreed behavior behind it is in [domain behavior](domain-behavior.md). Every
operation here uses the participant's bearer session.

## Delivery metadata

Message POST responses, conversation GET messages, recovery pages and SSE
`message` events carry the signed envelope (version 2) plus these
server-authoritative fields:

| Field | Meaning |
| --- | --- |
| `delivery_policy` | Always `recipient-opening` |
| `created_at` | Acceptance time, integer Unix milliseconds |
| `opened_at` | First recipient opening time, integer Unix milliseconds, or `null` |
| `expires_at` | Effective deadline, integer Unix milliseconds |

`ttl` remains the signed lifetime in seconds. The metadata fields are outside
the signature. Shared `verifyDeliveredMessage` verifies the original signature
and validates the deadline; both clients use it. An unopened message expires at
acceptance + 86,400,000 ms. Opening before that deadline sets expiry to
opening + the full signed TTL, which can shorten or extend the unopened
deadline. Availability ends at `now >= expires_at`. GET, recovery, state lookup
and SSE delivery never open messages.

Push alerts wait at most until acceptance plus the unopened retention limit,
regardless of a later opening.

## Client capability

The browser and CLI send `X-0xChat-Delivery-Capability: recipient-opening-v1` on
every request. Send, conversation read, conversation list, clear, open, state,
recover, SSE token and attention requests without it return 426
`{ "error": "This 0xChat client is out of date. Reload the page or update the CLI.", "code": "client_update_required" }`.
The check follows authentication, so a missing session is still 401. Push
subscription management, session removal, registration removal, registration
and authentication stay open to every client.

On `client_update_required` the browser and CLI stop their retry loops. The
browser shows a "Reload to update" action, which fetches the newest service
worker before reloading.

## Opening

`POST /api/messages/:counterparty/open`, authenticated by the recipient, accepts
exactly `{ "ids": ["0x…"] }`: 1–100 distinct canonical lowercase 16-byte hex
message IDs from one conversation. A valid request returns 200:

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
non-recipient IDs all return the same unavailable shape. Already-opened IDs
confirm the existing deadline. A write transaction acquires the lock before
sampling server time and checking availability, so concurrent openings and
lost-response retries cannot restart lifetimes. Retries after expiry return
unavailable. The server authenticates the recipient; it cannot prove decryption
or human attention.

Each first opening publishes SSE `expiry-update` to both participants after
commit. Its payload contains exactly `id`, `sender`, `recipient`, and the four
metadata fields above — no ciphertext, signature or plaintext. Retries do not
publish another update. SSE is not a durable event log; clients refresh
authoritative state after a lost stream.

## Lifecycle lookup

`POST /api/messages/:counterparty/state` takes the same `{ "ids": [...] }` body
and returns the same `server_time` and ordered `results` shape as opening. Both
participants can query either direction in their conversation. The operation
reads a consistent snapshot and never changes opening state or emits expiry
updates.

## Recovery

`GET /api/messages/:counterparty` supports `limit`, `before`, and `before_rowid`
and returns `messages`, `next_before`, `next_before_rowid`, and an opaque
`recovery_cursor`. History and this checkpoint are captured in one SQLite
snapshot. The checkpoint is the server's acceptance high-water mark at that
snapshot, including when no messages remain — not the last message's ID,
timestamp or rowid. Treat cursors as opaque. For a new conversation view,
establish SSE first and buffer events, then load the initial page and keep its
checkpoint. Fetching older pages does not replace it; completed recovery does.

After a lost stream, call
`GET /api/messages/:counterparty/recover?after=<recovery_cursor>`. The server
captures an inclusive upper acceptance bound; the checkpoint is the exclusive
lower bound. It returns up to 100 currently available messages in ascending
acceptance order:

```json
{
  "messages": [],
  "server_time": 2000,
  "exhausted": true,
  "next_cursor": null,
  "recovery_cursor": "opaque-completed-checkpoint"
}
```

When `exhausted` is false, continue with `?cursor=<next_cursor>` until it is
true. Only an exhausted response supplies the new checkpoint. Exactly one
`after` or `cursor` parameter is required. Continuation tokens keep the original
upper bound and advance past the last returned message even if it has since
expired, so an empty exhausted page still yields a checkpoint. New messages
beyond the bound belong to buffered live events or a later recovery. Keep the
previous checkpoint until every page has been merged by message ID.

Cursors are signed with a database-persisted key and scoped to the requesting
identity and conversation. They survive session renewal and restart, but not
database replacement. Malformed, forged, wrong-kind, wrong-identity or
wrong-conversation cursors return 400.

## Errors and limits

Messages are limited to 4096 bytes of UTF-8 plaintext (4 KiB), not characters.
Each encrypted copy may contain at most 4112 bytes, including the 16-byte
AES-GCM tag, or 8226 characters as hex with the `0x` prefix. A message with
either ciphertext above this limit is rejected with 400. The browser and CLI
block oversized messages before sending them.

The server sets a global request body cap of 32 KiB (32768 bytes). An oversized
`Content-Length` is rejected with 413 before routing; bodies read from chunked
uploads without `Content-Length` are rejected with 413 as soon as they exceed
the cap. Routes that ignore a body or reject a request early may respond before
a chunked upload reaches the cap. The send endpoint (`POST /api/messages`) also
enforces this 32 KiB limit while reading the JSON envelope.

Malformed requests return 400; missing or invalid sessions 401; outdated
clients 426; rate-limited requests 429. Opening and state lookup bodies are
limited to 8 KiB, including streamed bodies (413 beyond that). Opening, state
lookup and recovery each have an independent budget of 120 requests per minute
per identity and 240 per IP; none consumes the sending budget or another's.
