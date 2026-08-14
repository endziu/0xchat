# Maintainer reference

## Technology

- **Client:** Preact, Tailwind CSS v4, Vite
- **Server:** Bun HTTP server
- **Database:** SQLite via `bun:sqlite`
- **Live delivery:** Server-Sent Events (SSE)
- **Offline alert:** standards-based Web Push (VAPID)
- **Crypto:** `@noble/secp256k1`, Web Crypto, and `viem`


## System flow

### Identity and registration

A first visit generates a secp256k1 keypair and saves it under `eth_chat_burner_v1`. Registration uses a rate-limited, single-use challenge that binds the `0xChat key registration v1` context, request origin, normalized address, normalized compressed public key, and nonce. The server verifies the signature and confirms that the key derives the claimed address. Clients independently validate fetched encryption keys before use.

### Authentication

The client requests a unique authentication challenge, signs it, and exchanges it for a 24-hour bearer token. Tokens are stored with their owning address and loaded only for the active identity; legacy unbound tokens are discarded. A `401` clears the local token. SSE access uses a separate short-lived token so bearer credentials are not placed in an event-stream URL.

### Message protocol

Protocol v1 is the only accepted format. The sender creates a random 128-bit message ID and canonical metadata containing the version, ID, sender, recipient, and TTL. That metadata is AES-GCM additional authenticated data for both encrypted copies. The sender then EIP-191-signs a canonical envelope containing metadata, ciphertexts, ephemeral public keys, and IVs.

The server verifies session ownership, protocol version, payload shape, TTL, recipient, signature, and unique ID before storing or notifying. Fetch and SSE clients repeat envelope and participant validation before decryption. Missing or unsupported versions receive `400`; there is no legacy fallback or silent downgrade. On the initial protocol-v1 schema cutover, unexpired legacy rows are deleted because they cannot be authenticated safely.

### Delivery, contacts, and expiry

After persistence, the server notifies connected participants over SSE. Conversation lists merge active server conversations with browser-local known contacts. Local deletion markers hide a contact until newer server activity supersedes the marker. Unread state uses per-address `last_seen` values.

Messages support only TTLs defined by `VALID_TTLS` in `src/server/constants.ts`. The server removes expired messages and sessions every 30 seconds; clients remove messages using timers or refresh.

Deleting an account removes its registered key, sessions, conversations, and push subscriptions, then emits `user:disconnected` to known partners.

### Push notifications

Push is a side-channel after message persistence and SSE notification. It is fire-and-forget and never blocks message sending. The message's remaining lifetime becomes the Web Push `TTL` header.

Push requests contain no payload. The service worker ignores `event.data`, displays hardcoded generic text, and always opens `/chat`. One address may have several subscriptions; delivery fans out to each. Provider responses `404`/`410` prune dead endpoints. Account deletion removes all subscriptions for that address.

The client only checks for an existing subscription on mount and requests a new one from an explicit user gesture. Logout unsubscribes browser- and server-side first. `pushsubscriptionchange` renewal and installation-level presence suppression are intentionally deferred; an open conversation may therefore still receive a generic push.

### PWA behavior

The service worker precaches `/chat` and icons, uses network-first navigation, and cache-first hashed assets. It never intercepts `/api/*`. `viewport-fit=cover`, safe-area utilities, 44×44 coarse-pointer controls, guarded hover affordances, and a maskable icon support mobile installation. `bun run icons` regenerates PNGs and SVG assets; the generator writes PNG data directly with CRC32 and `Bun.deflateSync`.

## Crypto scheme

- **Entropy:** `crypto.getRandomValues(32)`
- **Curve:** secp256k1
- **Address:** standard Ethereum address derived from the uncompressed public key
- **Encryption:** ephemeral ECDH → HKDF-SHA-256 → AES-GCM-256
- **Authenticated metadata:** canonical envelope fields supplied as AES-GCM AAD
- **Envelope authentication:** EIP-191 signature over complete protocol-v1 content
- **Encoding:** API and database hex strings use a `0x` prefix
- **Libraries:** `@noble/secp256k1` v3 and `viem`

## HTTP API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/*` | — | Serve `dist/` or the SPA fallback |
| `POST` | `/api/register/challenge` | — | Issue a single-use registration challenge |
| `POST` | `/api/register` | — | Verify signature and register an address/public key |
| `GET` | `/api/pubkey/:addr` | — | Look up a registered public key; may return `null` |
| `POST` | `/api/auth/challenge` | — | Issue an authentication challenge |
| `POST` | `/api/auth/session` | — | Verify signature and issue a bearer token |
| `POST` | `/api/messages` | Bearer | Send a signed, double-encrypted message or image |
| `GET` | `/api/messages/:addr` | Bearer | Fetch conversation history |
| `GET` | `/api/conversations` | Bearer | List active conversations |
| `DELETE` | `/api/addresses/:addr` | Bearer | Delete the authenticated account and its server data |
| `POST` | `/api/events/token` | Bearer | Exchange bearer auth for a short-lived SSE token |
| `GET` | `/api/events?token=` | SSE token | Open the event stream |
| `GET` | `/api/push/vapid-public-key` | — | Return VAPID public key; `503` if unconfigured |
| `POST` | `/api/push/subscribe` | Bearer | Upsert a subscription for the authenticated address |
| `POST` | `/api/push/unsubscribe` | Bearer | Delete an address/endpoint subscription |

In the production Nginx configuration, only `/api/*`, static-asset extensions, `/chat`, `/chat/*`, `/pk`, and exact `/` are reachable; other paths return `444`. Add new server endpoints under `/api/`.
