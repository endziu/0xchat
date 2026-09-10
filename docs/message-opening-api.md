# Message delivery and opening contract

Implemented by issue #75. Production continues to accept `legacy` deliveries.
Browser/CLI reveal behavior and rollout enforcement belong to dependent tickets.

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

Clients can advertise `X-0xChat-Delivery-Capability: recipient-opening-v1` on
requests. `advertisesDeliveryCapability` detects that exact value independently
of signed-envelope version. SSE token minting captures it; stream admission
inherits the token's captured capability, never a query-string override.
`openingConnectionCount` exposes capable live streams for the later rollout gate.
Missing/unknown capability is accepted today; admission, sending and reading
remain unenforced. Token expiry, single use and connection caps still apply.

## Isolated validation

`createFetch({ testDeliveryPolicy: 'recipient-opening' })` enables new-policy
acceptance for test servers only and throws outside `NODE_ENV=test`. The
production entry point calls `createFetch()` and has no environment activation
switch. Tests explicitly initialize an in-memory or temporary SQLite database.
Do not run `bun run test` in the working checkout: it deletes `chat.db` and
`dist`. Run that full command from an isolated copy with its own database.

No client reveal/acknowledgement UI, rollout gate, recovery API, push TTL change,
or push endpoint allowlist change is included in this slice. Deploy the rebuilt
frontend alongside the server and refresh existing browser tabs so they load the
updated shared delivery validator. Older strict delivery validators reject the
added fields even though the signed-envelope version is unchanged. There are no
production CLI clients, so CLI compatibility does not block this deployment.
