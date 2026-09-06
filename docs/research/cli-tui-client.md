# CLI / TUI client for 0xChat

Date: 2026-09-07

What it would take to ship a terminal client that talks to the 0xChat server exactly as the webapp
does: the full wire contract a non-browser client must implement, which browser APIs the current
client leans on and what replaces them under Bun, which TUI frameworks actually run under Bun, the
parts that are genuinely hard, and three architectures with a recommendation.

The repo at `main` (`b4277a0`) is the primary source and is cited inline as `path:line`. External
claims cite the project or standard that owns them (Sources list at the end); all external sources
were accessed on 2026-09-07. Where a claim was established by running code rather than by reading a
doc, it is marked **[probe]** and the probe is described in §1.7 — those runs used Bun 1.4.0 on
Linux x64 against `server.ts` at `b4277a0`, with a throwaway database outside the repo.

## Summary

1. **The wire contract is small and fully implementable outside a browser.** Nine API endpoints, one
   bearer token, EIP-191 signatures over three canonical, versioned strings, and one ECIES-style
   envelope. A headless Bun script registered two identities, minted sessions, sent an encrypted
   message, received it live, and decrypted it — with no DOM, no shim, and no code copied out of
   `src/client/components` **[probe]**.
2. **Every crypto primitive the client needs already works in Bun.** The scheme is
   secp256k1 ECDH → HKDF-SHA-256 → AES-256-GCM (`src/client/lib/crypto.ts:15-83`), built from
   `@noble/secp256k1`, `viem` and WebCrypto. Bun lists `crypto`, `Crypto` and `SubtleCrypto` among
   its Web globals [BUN-GLOBALS, BUN-WEBAPI] and the full round trip verified **[probe]**.
3. **The one transport gap is `EventSource`.** Bun 1.4.0 has no `EventSource` global — `typeof
   EventSource` is `undefined`, it is absent from `Object.getOwnPropertyNames(globalThis)` and from
   the `bun` module, and `new EventSource(...)` throws "undefined is not a constructor" **[probe]**;
   it is likewise absent from Bun's globals table [BUN-GLOBALS]. This costs nothing: the SSE frame
   format the server emits (`src/server/sse.ts:42`) is four lines of parsing over
   `fetch(...).body`, and the webapp already drives reconnection by hand because browser
   `EventSource` cannot recover from this server's single-use tokens (`src/client/lib/sse-connection.ts:1-21`).
4. **`localStorage` is the deepest browser coupling, and it is confined to four small files**:
   `burner.ts:43-57`, `session.ts:12-70`, `contacts.ts:17-62`, `storage-migration.ts:3-7`. Nothing
   else in `src/client/lib` touches the DOM except `image.ts` (canvas) and two `window.location.origin`
   reads in `api.ts:78,109`. That is a clean seam for a shared core.
5. **Ink 7.1.1 with React 19.2.8 renders correctly under Bun 1.4.0** in a pty **[probe]**, and
   **OpenTUI 0.5.10 loads its native Zig core under Bun on linux-x64** (278 exports, FFI resolved,
   `core-linux-x64` and `core-linux-x64-musl` installed) **[probe]**. Both are viable; blessed
   (last published 2015) and neo-blessed (2018) are not [NPM-BLESSED, NPM-NEO-BLESSED].
6. **Backfill exists but is thin, and is bounded by expiry.** `GET /api/messages/:address` returns
   whatever has not yet expired, newest-first, with a `(created_at, rowid)` cursor
   (`src/server/routes/messages.ts:97-133`, `src/server/db.ts:219-257`). There is no
   `Last-Event-ID` handling anywhere in the SSE route (`src/server/routes/events.ts:90-151`), so a
   reconnecting client must refetch, and anything that expired while it was offline is simply gone —
   `expires_at = created_at + ttl*1000` is stamped at acceptance (`src/server/db.ts:172-173`).
7. **Push notifications do not apply, and that is fine.** The push path is Web Push over a service
   worker bound to four allowlisted browser push services (`src/server/validation.ts:27-36`); a
   terminal process has no push service and needs none, because it holds the SSE stream open itself.
8. **Recommendation: extract a `src/core` package from the DOM-free half of `src/client/lib`, add a
   fourth tsconfig, and build the TUI on Ink.** Details and rationale in §6.

---

## 1. The wire contract

Everything below is what a non-browser client must send and accept. Router table:
`src/server/router.ts:24-41`.

### 1.1 Endpoints

| Method | Path | Auth | Request | Response | Source |
|---|---|---|---|---|---|
| `POST` | `/api/register/challenge` | none | `{address, pubkey}` | `{challenge, nonce}` | `routes/register.ts:18-53` |
| `POST` | `/api/register` | none | `{address, pubkey, signature, nonce}` | `{ok: true}` | `routes/register.ts:55-108` |
| `GET` | `/api/pubkey/0x…40hex` | none | — | `{pubkey: "0x02…" \| null}` | `routes/pubkey.ts:5-9` |
| `POST` | `/api/auth/challenge` | none | `{address}` | `{challenge, nonce}` | `routes/auth.ts:15-47` |
| `POST` | `/api/auth/session` | none | `{address, signature, nonce}` | `{token, expires_at}` | `routes/auth.ts:50-99` |
| `DELETE` | `/api/session` | bearer | — | `204`, empty body | `routes/session.ts:6-15` |
| `POST` | `/api/messages` | bearer | signed envelope (§1.3) | `201` + `DeliveredMessage` | `routes/messages.ts:39-95` |
| `GET` | `/api/messages/0x…40hex` | bearer | `?before=&before_rowid=&limit=` | `{messages[], next_before, next_before_rowid}` | `routes/messages.ts:97-133` |
| `GET` | `/api/conversations` | bearer | — | `{conversations: [{address, last_message_at}]}` | `routes/messages.ts:135-146` |
| `DELETE` | `/api/addresses/0x…` | bearer | — | `{success: true}` | `routes/account.ts:8-35` |
| `POST` | `/api/events/token` | bearer | — | `{sse_token}` | `routes/events.ts:72-88` |
| `GET` | `/api/events?token=…` | SSE token | — | `text/event-stream` | `routes/events.ts:90-151` |
| `GET` | `/api/push/vapid-public-key` | none | — | `{publicKey}` or `503` | `routes/push.ts:9-12` |
| `POST` | `/api/push/subscribe` | bearer | `PushSubscriptionJSON` | `201` | `routes/push.ts:14-54` |
| `POST` | `/api/push/unsubscribe` | bearer | `{endpoint}` | — | `routes/push.ts:57-…` |

Conventions a CLI must match:

- **Auth header**: `Authorization: Bearer <token>`; anything else is treated as absent
  (`src/server/http.ts:38-42`). The token is looked up by SHA-256 digest, so the raw token exists
  only on the client (`src/server/db.ts:8-10,146-159`).
- **Addresses on the wire are lowercase.** Every route lowercases before matching
  (`routes/register.ts:31`, `routes/auth.ts:29`, `routes/messages.ts:105`) and the envelope parser
  rejects any non-lowercase address outright (`src/shared/message-envelope.ts:34,100-101`).
- **Errors** are `{error: string}` with an optional machine-readable `code`; the only defined code is
  `unsupported_push_service` (`src/shared/api-error.ts:1-6`).
- **Trailing slashes are stripped** before routing (`src/server/router.ts:53`).

### 1.2 Authentication: challenge → EIP-191 signature → bearer token

Both the registration and session flows are: ask for a challenge, sign the exact string that comes
back, post the signature with the nonce. The server rebuilds nothing — it stores the challenge it
issued and recovers the signer with `viem`'s `recoverMessageAddress`, comparing case-insensitively
(`src/server/verify.ts:3-16`).

**Registration challenge** (`src/shared/registration-challenge.ts:8-14`), newline-joined:

```
0xChat key registration v1
Origin: <origin>
Address: <lowercase address>
Public key: 0x<66-hex compressed pubkey>
Nonce: <32 hex chars>
```

**Session challenge** (`src/shared/session-challenge.ts:6-11`):

```
0xChat session request
Origin: <origin>
Address: <lowercase address>
Nonce: <32 hex chars>
```

Details that bite a non-browser client:

- **`Origin` matters.** The server takes the `Origin` header, and only falls back to the request
  URL's origin when the header is absent (`src/server/origin.ts:6-14`). The challenge is bound to
  that origin at issue time and re-checked at consume time (`src/server/challenge.ts:33-40,67`). The
  webapp verifies the returned challenge equals what it expected from `window.location.origin`
  (`src/client/lib/api.ts:77-84,108-114`) — a CLI must do the same against its configured base URL,
  and should send an explicit `Origin` header so that a server behind a reverse proxy (whose
  `req.url` origin is the internal one) still produces a challenge the client can verify.
- **Nonce** is 16 random bytes hex (`src/server/challenge.ts:38`); challenges live 5 minutes and are
  single-use, one per subject (`src/server/challenge.ts:16,42,60-71`). The registration
  subject is `address:pubkey` (`routes/register.ts:14-16`), the session subject is the address
  (`routes/auth.ts:41-46`).
- **Signature format** is a 65-byte EIP-191 `personal_sign` signature as `0x` + 130 hex — validated
  by regex before recovery (`src/server/validation.ts:8`). `viem`'s
  `privateKeyToAccount(...).signMessage({ message })` produces exactly this
  (`src/client/lib/burner.ts:35-38`) and it works unchanged in Bun **[probe]**.
- **Public key must be the address's own key.** The server decompresses the candidate point,
  keccak256s the uncompressed body minus its `0x04` prefix, and requires the last 20 bytes to equal
  the claimed address (`src/shared/address-bound-pubkey.ts:8-31`). The wire form is a compressed
  point, `0x02`/`0x03` + 64 hex, lowercase.
- **Sessions last 24 h** (`src/server/constants.ts:44`) and the response carries `expires_at`
  (`routes/auth.ts:99`). Expired tokens are deleted on lookup (`src/server/db.ts:154-157`), so a
  CLI should treat any `401` as "re-run the session flow", which is what the webapp does
  (`src/client/lib/api.ts:39-51`).

### 1.3 Message envelope

Version 2, twelve keys exactly — the parser rejects an object with any extra or missing key
(`src/shared/message-envelope.ts:38-43,97`):

```
version: 2
id: 0x + 32 lowercase hex   (16 random bytes)
sender / recipient: 0x + 40 lowercase hex
ttl: positive safe integer, must be in VALID_TTLS
ct_recipient / ct_sender: 0x + even lowercase hex, ≥34 chars, ≤2_000_002 chars
ephemeral_pub_recipient / ephemeral_pub_sender: 0x + compressed secp256k1 point (on-curve check)
iv_recipient / iv_sender: 0x + 24 lowercase hex (12 bytes)
signature: 0x + 130 lowercase hex
```

Every message is encrypted **twice** — once to the recipient, once to the sender's own key — so the
sender can still read its own history (`src/client/lib/message-envelope.ts:29-30`). Both copies
share one `id` and one AAD.

**AAD** (authenticated, not encrypted), newline-joined
(`src/shared/message-envelope.ts:45-54`):

```
0xChat message AAD v2
Version: 2
Message ID: <id>
Sender: <sender>
Recipient: <recipient>
TTL: <ttl>
```

**Signed string** (`src/shared/message-envelope.ts:56-71`): the literal
`0xChat signed message envelope v2` followed by `Version:`, `Message ID:`, `Sender:`, `Recipient:`,
`TTL:`, `Recipient ciphertext:`, `Recipient ephemeral public key:`, `Recipient IV:`,
`Sender ciphertext:`, `Sender ephemeral public key:`, `Sender IV:` — in that order, joined with
`\n`. It is signed EIP-191 by the sender and re-verified server-side
(`src/shared/message-envelope.ts:110-123`). The test at `src/shared/message-envelope.test.ts:52-53`
pins a byte-exact signature for a fixed key, which is a ready-made conformance vector for a second
implementation.

Server-side acceptance checks, in order (`routes/messages.ts:59-85`): version, shape, sender equals
the session address (`403` if not), recipient is not self, TTL in the allowed set, recipient is
registered (`400 Recipient not registered`), signature recovers to the sender, and `id` is unused
(`409 duplicate message ID` — the insert is `INSERT OR IGNORE`, `src/server/db.ts:175-187`).

**Valid TTLs** are exactly `5, 10, 30, 60, 300, 1800, 3600, 21600, 86400` seconds
(`src/server/constants.ts:43`).

**Size cap**: ciphertext hex ≤ 2,000,002 chars, i.e. ≤ 1,000,000 bytes, so plaintext ≤ 999,984 bytes
after the 16-byte GCM tag (`src/shared/message-envelope.ts:7-9`).

On success the server returns `201` with the envelope plus `created_at` and `expires_at`, and
fans the same object out over SSE to **both** recipient and sender (`routes/messages.ts:87-94`).

The delivered form is re-verified client-side before display, including the invariant
`expires_at === created_at + ttl*1000` and that the identity is a participant
(`src/shared/message-envelope.ts:125-140`) — a CLI should keep that check rather than trusting the
stream.

### 1.4 Crypto primitives, exactly

| Step | Parameter | Value | Source |
|---|---|---|---|
| Identity key | curve | secp256k1, 32 random bytes from `crypto.getRandomValues` | `src/client/lib/burner.ts:14` |
| Public key | encoding | compressed, 33 bytes, hex-lowercase with `0x` | `burner.ts:20-21` |
| Address | derivation | `keccak256(uncompressed_pubkey[1..])`, last 20 bytes, EIP-55 checksummed locally, lowercased on the wire | `burner.ts:28-30` |
| Signing | scheme | EIP-191 `personal_sign` via `viem` `privateKeyToAccount().signMessage()` | `burner.ts:35-38` |
| ECDH | function | `secp.getSharedSecret(priv, pub, true)` → **33 bytes, prefix byte included** (not the bare x-coordinate) | `crypto.ts:49,73`; 33 confirmed **[probe]** |
| KDF | algorithm | HKDF, `hash: 'SHA-256'` | `crypto.ts:20-34` |
| KDF salt | value | the **compressed ephemeral public key**, 33 bytes | `crypto.ts:27,50,74` |
| KDF info | value | UTF-8 `"0xChat AES-GCM v2"` | `crypto.ts:28` |
| KDF output | key | AES-GCM, 256-bit, non-extractable, single usage | `crypto.ts:31-33` |
| Cipher | algorithm | AES-256-GCM, 16-byte tag (WebCrypto default) | `crypto.ts:53-55` |
| IV | size | 12 random bytes per copy, sent in the clear as `iv_*` | `crypto.ts:52` |
| AAD | value | the canonical AAD string, UTF-8 | `crypto.ts:54`, `src/shared/message-envelope.ts:45-54` |
| Encoding | hex | `viem` `bytesToHex`, lowercase, `0x`-prefixed throughout | `crypto.ts:58-60` |

Two easy ways to get this wrong in a reimplementation: passing the 32-byte x-coordinate instead of
the 33-byte compressed shared secret to HKDF, and using an empty or random salt instead of the
ephemeral public key. Both produce a client that encrypts happily and can never be decrypted by the
webapp.

### 1.5 Live transport: SSE, with a two-step handshake

There is no WebSocket and no polling. Delivery is Server-Sent Events, gated by a second token:

1. `POST /api/events/token` with the bearer token → `{sse_token}`, 16 random bytes hex, **30-second
   TTL, single-use, bound to one address** (`routes/events.ts:9,33-37,50-55,106`).
2. `GET /api/events?token=<sse_token>` → `text/event-stream` (`routes/events.ts:145-150`).

Frames are the minimal SSE form, `event: <name>\ndata: <json>\n\n`
(`src/server/sse.ts:42`). Three event names exist:

- `ping` — `{}`, sent immediately on connect and every 30 s (`routes/events.ts:108,127-136`);
- `message` — a `DeliveredMessage` (`routes/messages.ts:88-89`);
- `user:disconnected` — `{address}`, when a partner deletes their identity (`routes/account.ts:31`).

There is **no `id:` field and no `Last-Event-ID` handling**, so SSE resumption is not available;
reconnect means refetch (§4.2). The connection cap is **3 concurrent streams per address**
(`src/server/constants.ts:48`, enforced at `routes/events.ts:101-104`) — a CLI shares that budget
with the user's browser tabs. The cap is checked *before* the token is consumed, deliberately, so a
rejected client can retry the same token once a slot frees (`routes/events.ts:99-106`).
`Bun.serve` runs with `idleTimeout: 60` (`server.ts:22`), which the 30-second heartbeat stays under.

### 1.6 Rate limits and retention a CLI must respect

| Limit | Value | Key | Source |
|---|---|---|---|
| Send message | 120/min | `ip:address` | `rate-limiters.ts:10` |
| Send message (aggregate) | 240/min | `ip` | `rate-limiters.ts:14` |
| Auth challenge / session | 10/min each | `ip` | `rate-limiters.ts:17,20` |
| Register challenge / register | 10/min each | `ip` | `rate-limiters.ts:23,26` |
| **SSE token mint** | **10/min** | `ip` | `rate-limiters.ts:32` |
| Push subscribe | 10/min | `ip:address` | `rate-limiters.ts:29` |
| Session lifetime | 24 h | — | `constants.ts:44` |
| Registration retention | 30 days without a new session or message | — | `constants.ts:45`, `db.ts:124-126` |
| Cleanup sweep | every 30 s | — | `server.ts:8-12` |

The SSE-token limit is the one a reconnect loop can trip: ten mints per minute per IP, shared with
every other client behind the same NAT. The webapp's backoff is 1 s doubling to 30 s
(`src/client/lib/sse-connection.ts:21,54,145-149`); a CLI should not be more aggressive.

Registration is pruned after 30 days of inactivity, where "activity" is creating a session or
sending/receiving a message (`db.ts:138,188`) — a long-idle CLI identity that never opens a session
will eventually stop being messageable.

### 1.7 What was verified by running it

A throwaway Bun script (deleted after the run; the repo tree stayed clean) started `server.ts` on
port 3999 with a database outside the repo and, using only `@noble/secp256k1`, `viem`, WebCrypto and
`fetch`:

- registered two fresh identities (`200`, `200`) and minted two sessions;
- opened `GET /api/events` with plain `fetch` and read `sseRes.body` as a stream — status `200`,
  `content-type: text/event-stream`, first frame `event: ping\ndata: {}`;
- posted a signed envelope (`201`), with `expires_at - created_at === 300000` for `ttl: 300`;
- received the `event: message` frame on the recipient's stream and **decrypted it back to the
  original plaintext**;
- confirmed backfill: `GET /api/messages/<sender>` returned 1 message with a non-null `next_before`,
  and `GET /api/conversations` listed the partner with `last_message_at`;
- confirmed a second concurrent stream is admitted (`200`) and that **reusing an SSE token yields
  `401 Invalid or expired token`**.

That is the whole client contract, exercised end to end from a terminal process.

---

## 2. Browser APIs in the current client, and their Bun equivalents

| Browser API | Where it is used today | Bun/Node equivalent | Notes |
|---|---|---|---|
| WebCrypto `crypto.subtle` (HKDF, AES-GCM) | `crypto.ts:20-34,53-55,78-80` | Same API — Bun lists `crypto`, `Crypto`, `SubtleCrypto` as Web globals [BUN-GLOBALS, BUN-WEBAPI] | Round trip works unchanged **[probe]**. No code change at all. |
| `crypto.getRandomValues` | `burner.ts:14`, `crypto.ts:13`, `message-envelope.ts:22` | Same global | Works **[probe]**. |
| `fetch` / `Headers` / `Request` | `api.ts:38` | Bun implements Fetch, Request, Response, Headers [BUN-WEBAPI] | Only change: relative `/api/...` paths must become absolute against a configured base URL. |
| `EventSource` | `sse-connection.ts:64,101` | **Missing in Bun 1.4.0** **[probe]**; not in the globals table [BUN-GLOBALS] | Parse `fetch(...).body` yourself: split on `\n\n`, then on `\n`, take `event:` and `data:`. The existing `SseConnection` already injects `createEventSource` as a test seam (`sse-connection.ts:35`), so a Bun adapter drops straight in. |
| `localStorage` | `burner.ts:43-57`, `session.ts:12-70`, `contacts.ts:17-62`, `storage-migration.ts:3-7` | No `localStorage` in Bun **[probe]**; not in the globals table [BUN-GLOBALS] | Replace with a file store (§4.1). This is the only place where the CLI needs genuinely different behaviour rather than a different binding. |
| `window.location.origin` | `api.ts:78,109` | n/a | Becomes the configured server base URL, which the CLI also sends as `Origin`. |
| `globalThis.dispatchEvent(new CustomEvent('auth:expired'))` | `api.ts:48` | `EventTarget`/`Event` exist in Bun [BUN-WEBAPI] | Works as-is, or swap for a callback when the core is extracted. |
| Canvas / `createImageBitmap` / `FileReader` | `image.ts:75-112` | None in Bun | Image *compression* has no drop-in replacement (§4.3). Sending an already-small image needs only base64, which Bun does natively. |
| Service worker + Push API | `main.tsx:8-12`, `public/sw.js`, `hooks/usePushSubscription.ts` | None, and none needed | §4.6. |
| `Notification` | via the service worker | `undefined` in Bun **[probe]** | Terminal bell / OSC 9, or nothing. |
| Camera + `jsQR` for QR scanning | `components/QRModal.tsx:39-60` | None | A CLI takes the address as an argument; scanning is not a terminal affordance. Rendering a QR *is* (§4.5). |
| TTY: raw mode, size, resize | n/a (browser) | `process.stdin.setRawMode` is a function and `process.stdin.isTTY` is true under a pty **[probe]**; `node:tty` is implemented (`ReadStream` is a function) **[probe]**. Semantics per Node: raw mode gives character-by-character input with echo and SIGINT disabled, and `'resize'` fires when `columns`/`rows` change [NODE-TTY] | Everything a TUI needs is present. Note `columns`/`rows` read `0` under a zero-sized pty **[probe]** — a TUI must tolerate that, which both frameworks below do. |
| File permissions for the key file | n/a | `node:fs` under Bun honours `mkdirSync(..., {mode: 0o700})` and `writeFileSync(..., {mode: 0o600})` — verified `700`/`600` **[probe]** | §4.1. |

---

## 3. TUI frameworks under Bun

Registry metadata below is from the npm registry API on 2026-09-07 [NPM-REGISTRY].

| Project | Latest | Last publish | Runs under Bun? | Rendering model | Input | Verdict |
|---|---|---|---|---|---|---|
| **Ink** | 7.1.1 | 2026-07-16 | **Yes, verified** — Ink 7.1.1 + React 19.2.8 rendered a bordered, coloured box under Bun 1.4.0 in a pty **[probe]** | React reconciler → Yoga flexbox → ANSI on stdout [INK] | `useInput` hook over stdin; `useStdin().isRawModeSupported`; Ink manages `setRawMode` [INK] | **Viable and the safe default.** `engines: node >= 22`, MIT. Historic Bun friction was module resolution of `react-devtools-core` (issue #650, closed "not planned") [INK-650] — not reproduced here. |
| **OpenTUI** (`@opentui/core`) | 0.5.10 | 2026-09-01 | **Yes for loading** — installed `core-linux-x64` + `core-linux-x64-musl` and imported cleanly (278 exports, `createCliRenderer` a function) **[probe]**. A full-renderer smoke test in a synthetic zero-sized pty produced no output within 60 s — **unverified** in a real terminal | TypeScript over a native Zig core through FFI; flexbox boxes, selects, inputs, scroll boxes, mouse; can show images and 3D [OPENTUI-README] | Keyboard and mouse handled by the core [OPENTUI-README] | **Viable, more capability, more risk.** Requires "Bun 1.3.0 or later" (1.4.0+ on Windows arm64) or "Node.js 26.4.0 or later" with `--experimental-ffi`; eight native packages; "An available artifact does not prove runtime parity on every published target" [OPENTUI-RUNTIME]. Its image support is the one thing that could make terminal attachments cheap (§4.3). |
| **blessed** | 0.1.81 | **2015-09-03** | n/a | ncurses-like widget tree | — | **No.** Eleven years without a release [NPM-BLESSED]. |
| **neo-blessed** | 0.2.0 | **2018-06-13**, 2 versions total | n/a | fork of blessed | — | **No.** [NPM-NEO-BLESSED] |
| **terminal-kit** | 3.1.4 | 2026-07-19 | Not tested here — **unverified** | Imperative terminal API (styling, input fields, menus, screen buffers), not a component tree | Its own key handling | Maintained (`engines: node >= 16.13.0`), but imperative-only means writing the diffing and layout for a chat pane by hand. Reasonable fallback, poor fit for "modern TUI". |
| **@clack/prompts** | 1.7.0 | 2026-07-03 | Not tested here — **unverified** | Not a TUI framework: "an opinionated, pre-styled wrapper around `@clack/core`" providing individual prompts — text, select, multiselect, spinner, progress [CLACK] | Per-prompt | **Wrong tool for a chat UI**, right tool for a one-shot `0xchat send` or a first-run setup wizard. Could be used alongside the TUI. |
| **Textual** (Python, for contrast) | — | — | Irrelevant to Bun | "a _Rapid Application Development_ framework for Python"; apps "run in the terminal _or_ a web browser" and "can run over SSH" [TEXTUAL] | Python event loop | **Excluded.** A Python client would have to reimplement the entire crypto stack (§5, option B) — the worst possible trade for this repo. |

**Does Bun expose what a TUI needs?** Yes: raw mode (`process.stdin.setRawMode` present, `isTTY`
true under a pty) **[probe]**, `node:tty` implemented **[probe]**, terminal size and `'resize'` per
Node semantics [NODE-TTY], and ANSI is just bytes on stdout. Nothing needed a shim.

---

## 4. The hard parts, honestly

### 4.1 Key storage on disk

This is the highest-stakes decision in the whole project, because "your private key is your account"
(`README.md`) and the browser at least keeps the key inside an origin-scoped store. On disk it is a
file anyone with the user's uid — or a backup, or a sync client — can read.

What the repo gives us: the key is a raw hex string. Export is literally the private key in a text
input (`components/KeyManagement.tsx:55`) and import accepts hex with or without `0x`
(`KeyManagement.tsx:27`), so file-format interop with the webapp is trivial. Stored shape today is
`{privateKey, publicKey, address}` JSON under `0xchat_burner_v1` (`burner.ts:40,45`), with the
session token separately under `0xchat_session_v1` (`session.ts:3,12-16`).

Proposal:

- Location: `${XDG_CONFIG_HOME:-~/.config}/0xchat/` — `XDG_CONFIG_HOME` reads correctly under Bun
  **[probe]**. Identity in `identity.json`, session token in `session.json` (separate file: a
  24-hour token is not the same secret as the key), conversation labels and hidden-conversation
  state in `state.json`.
- Permissions: directory `0700`, files `0600`, set at creation via `node:fs` — verified to be
  honoured under Bun **[probe]**. Re-assert with `chmodSync` on every write, and refuse to start
  (with a clear message) if the identity file is group- or world-readable.
- Never put the key in a CLI argument or an environment variable — both leak through `ps` and shell
  history. Accept an *import* over stdin.
- Optional passphrase encryption at rest is achievable with the primitives already present
  (WebCrypto PBKDF2 or a scrypt from `node:crypto` → AES-GCM) but is a real UX cost for a burner app
  and should be opt-in, not default.
- The webapp's identity-switch machinery (`hooks/useIdentityTransition.ts`,
  `lib/identity-transition.ts`) is a good model for "prepare the new identity, then commit" — a CLI
  with multiple profiles wants the same ordering so a failed registration never strands the user.

### 4.2 Staying live: reconnect and backfill

Reconnect logic exists and is already correct for this server's quirks; only the socket differs.
`SseConnection` mints a fresh token per dial, backs off 1 s → 30 s, ignores errors from replaced
sockets, and keeps a single pending timer (`sse-connection.ts:21,54,101-107,145-149`). Its
`createEventSource`/`setTimeout`/`clearTimeout` seams (`sse-connection.ts:34-37`) were built for
tests and take a Bun `fetch`-stream adapter without modification.

Backfill is the honest weak spot:

- **What exists**: `GET /api/messages/:address?before=&before_rowid=&limit=` returns up to 100
  (default 50) non-expired messages newest-first with a `(created_at, rowid)` cursor
  (`routes/messages.ts:107-132`, `db.ts:219-257`), and `GET /api/conversations` gives the partner
  list with `last_message_at` (`routes/messages.ts:135-146`). That is enough to rebuild state after
  any outage: on `open`, refetch conversations, then the open conversation's first page.
- **What does not exist**: any resumption cursor on the stream. `handleSSE` never reads
  `Last-Event-ID` and never emits `id:` (`routes/events.ts:90-151`). So "what did I miss" is
  answered only by re-polling.
- **What is unrecoverable**: anything whose TTL lapsed while the client was down.
  `expires_at = created_at + ttl*1000` is stamped when the server accepts the message
  (`db.ts:172-173`), expired rows are excluded from every read (`db.ts:241`, `db.ts:274`) and deleted
  every 30 s (`server.ts:9`, `db.ts:282-284`). A CLI left closed for a minute has permanently missed
  every 5- and 10-second message. Note that `docs/domain-behavior.md` records an *agreed but
  unimplemented* change — start the lifetime when the conversation is opened, with a 24-hour
  unopened cap — which would change this materially and which a CLI should not try to emulate ahead
  of the server.
- **Unread state is local.** The server has no read receipts; the webapp keeps `last_seen_<address>`
  in `localStorage` (`contacts.ts:13`). A CLI needs its own equivalent in `state.json`, and the two
  will not agree across devices. That is inherent, not a CLI bug.

### 4.3 Image attachments in a terminal

An attachment is not a separate concept on the wire: the plaintext *is* a `data:image/...` data URL,
and the UI switches on the prefix (`components/MessagePane.tsx:194`). So **receiving** images needs
no protocol work at all — decrypt, check the prefix, decode the base64.

Displaying it is where terminals differ, and the honest summary is that no single method works
everywhere:

- **Kitty graphics protocol** — images as base64 inside `<ESC>_G<control data>;<payload><ESC>\`, in
  24-bit RGB, 32-bit RGBA or PNG, chunked at 4096 bytes. The protocol's own documentation lists
  Ghostty, Konsole, st (patched), Warp, wayst, WezTerm, iTerm2 and xterm.js as implementations, and
  notes that "most terminal emulators ignore APC codes, making it safe to use". Support is detected
  by sending a query action (`a=q`) alongside a device-attributes request and seeing which reply
  comes back [KITTY-GFX]. That detection handshake is the right basis for a runtime capability check.
- **iTerm2 inline images** — `ESC ] 1337 ; File = [args] : <base64> ^G`, any format macOS can
  decode; a multipart form exists for tmux 3.5+, and both tmux and iTerm2 cap a sequence at
  1,048,576 bytes [ITERM2-IMG]. This is explicitly an iTerm2 extension.
- **Sixel** — the oldest option: a sixel is "a group of six pixels in a vertical column", introduced
  by `DCS P1;P2;P3 q <data> ST` [VT340-SIXEL]. Encoding an arbitrary JPEG to sixel means writing or
  vendoring a quantizer.
- **Fallback that always works**: render a placeholder line — dimensions, byte size, expiry — plus
  an `--out` command that writes the decoded bytes to a file and, optionally, opens the system
  viewer. Nothing about the protocol requires drawing pixels in the terminal.

**Sending** images is harder than receiving. The webapp's compression pipeline is pure DOM —
`createImageBitmap`, a canvas, `toBlob('image/jpeg', quality)` (`image.ts:84-112`) — and the ladder
it walks (quality 0.85→0.25, then shrink by 0.75, floor 320 px, cap 1600 px) is deliberately split
out as a *pure generator*, `compressionAttempts` (`image.ts:29-43`), precisely because "the encoder
needs a DOM, this does not". That means a CLI can reuse the policy verbatim and only supply a
different encoder — a native `sharp`-style dependency, or an external `ffmpeg`/ImageMagick call, or
simply refusing anything already over `MAX_DATA_URL_LENGTH` (979,984 chars, `image.ts:7`) and telling
the user to resize it first. The last option ships in an afternoon and is a defensible v1.

### 4.4 Expiry countdowns

Cheap, given the data. Each delivered message carries `expires_at`, and the client verifies
`expires_at === created_at + ttl*1000` before trusting it (`src/shared/message-envelope.ts:131`). The webapp
sets one `setTimeout` per message and drops it on fire (`hooks/useMessages.ts:152-192`) — a TUI can
do the same, plus one ~1 Hz repaint tick while any message in view expires within a minute, so the
countdown visibly moves. Two details worth keeping: clear timers when the conversation changes
(`useMessages.ts:158-164`), and treat an already-expired message as immediately removed rather than
scheduling a negative timeout (`useMessages.ts:171-173`).

Server and client clocks can disagree — `created_at`/`expires_at` are server `Date.now()` values
(`db.ts:172-173`) compared against a local `Date.now()`. Anchoring the countdown to
`expires_at - Date.now()` at receive time and counting down locally avoids a persistent skew showing
as "expires in -3s".

### 4.5 QR codes in a terminal

Already solved by an existing dependency. The webapp encodes `${origin}/chat/${address}` into a
canvas (`components/QRModal.tsx:35-36`) using `qrcode`, which is already in `package.json`. The same
library renders to a terminal: `QRCode.toString(text, { type: 'terminal' })`, with a `small` option
described as "Relevant only for terminal renderer. Outputs smaller QR code." [QRCODE]. So
`0xchat qr` is a handful of lines and no new dependency. Scanning is the direction that does not
port — `jsQR` over a camera stream (`QRModal.tsx:39-60`) has no terminal equivalent, and a CLI
should simply accept the address as an argument.

### 4.6 Push notifications: not applicable

The background path is Web Push: a service worker registered from `main.tsx:8-12`, a subscription
uploaded to `/api/push/subscribe`, and endpoints restricted to four browser push services —
`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`,
`notify.windows.com` — specifically so the server cannot be used as an SSRF proxy
(`src/server/validation.ts:27-36`). A terminal process has no push service to subscribe to, and
`Notification` is undefined in Bun **[probe]**.

It also does not need one: push exists because a browser tab can be closed while the SSE stream is
not. A running CLI holds its own stream. If a desktop notification is wanted while the TUI is
backgrounded, that is a *local* concern — shell out to `notify-send`/`terminal-notifier`, or emit
OSC 9 — and it must stay content-free to match the existing design, where the push payload carries
no message content at all. The push endpoints should simply be left unimplemented in the CLI.

---

## 5. Architecture options

Three things about the repo shape the choice:

- **The crypto is already isolated and DOM-free.** `src/client/lib/crypto.ts` imports only
  `@noble/secp256k1`, `viem` and `./hex`; `src/shared/` (envelope, challenges, address binding, API
  error codes) is imported by *both* client and server today (`tsconfig.server.json` includes
  `src/shared/**/*.ts`; `tsconfig.client.json` includes `src/shared`). So the protocol layer is
  already a shared module in everything but name.
- **There is already a tsconfig split** — `tsconfig.client.json` (with `lib: ["DOM", ...]`),
  `tsconfig.server.json` (no DOM), and a solution-style root `tsconfig.json` with project references
  (`tsconfig.json:13-16`). Adding a fourth project is an established pattern here, not a new one.
- **The DOM coupling in `src/client/lib` is narrow and enumerable**: `localStorage` in four files,
  canvas in `image.ts`, `window.location.origin` twice and one `dispatchEvent` in `api.ts`
  (§2 table). Everything else — `crypto.ts`, `hex.ts`, `message-envelope.ts`, `encryption-key.ts`,
  `errors.ts`, `sse-connection.ts` (given its injected factory) — is portable as written.

### Option A — extract a shared core package

Move the DOM-free parts of `src/client/lib` into `src/core/` (`crypto.ts`, `hex.ts`,
`message-envelope.ts`, `encryption-key.ts`, plus a storage-agnostic `api.ts` that takes a base URL
and a `fetch`), and put `localStorage` behind a tiny `IdentityStore`/`SessionStore` interface with
two implementations: the existing `localStorage` one for the webapp, a file-backed one for the CLI.
`src/cli/` then holds only the TUI. Add `tsconfig.cli.json` (no DOM lib) and a `bun build --compile`
or `bun run src/cli/main.ts` entry.

- **For**: one implementation of the protocol, so a change to the envelope version or the AAD string
  cannot silently desynchronise two clients; the existing tests keep covering both; the refactor is
  mostly file moves plus two small interfaces.
- **Against**: it touches the webapp. `api.ts` grows a base-URL parameter, the four storage files
  gain a seam, and every importer updates. That is a real (if mechanical) diff in a codebase that is
  currently very tidy.

### Option B — standalone client, duplicated crypto

A separate package (possibly another language) reimplementing the envelope and the ECIES scheme
against the documented contract in §1.

- **For**: zero risk to the webapp; free choice of ecosystem (this is the only door to Textual).
- **Against**: two implementations of a security protocol with byte-exact canonical strings. The
  signed-envelope string, the AAD string, the 33-byte shared secret and the ephemeral-key salt must
  match exactly or messages become undecryptable — silently, since the failure surfaces as
  "Rejected undecryptable message envelope" and nothing more (`hooks/useMessages.ts:51-53`). The
  fixed-vector test at `src/shared/message-envelope.test.ts:52-53` mitigates this but does not
  remove the drift risk. **Not recommended.**

### Option C — thin TUI over a local daemon

A background Bun process holds the key, the SSE stream and the message cache, and exposes a local
socket; the TUI is a thin renderer, and other front-ends (a notifier, an editor plugin) can attach.

- **For**: solves "the SSE stream dies when I close the terminal" and the 3-streams-per-address cap
  in one move (one daemon = one stream, however many views); makes desktop notifications natural;
  makes the TUI restartable without re-registering.
- **Against**: a second long-lived process to supervise, an IPC protocol to design and secure (a
  `0600` unix socket in `$XDG_RUNTIME_DIR`, at minimum), and a daemon that holds the private key in
  memory indefinitely — which is a stronger claim on the user's trust than a foreground app they
  can quit. Also premature: nothing in the current product needs it.

---

## 6. Recommendation

**Option A (shared core) with Ink as the renderer**, and Option C's daemon explicitly deferred.

Why:

- The seam already exists in all but name — `src/shared/` is imported by both sides today, and the
  DOM coupling is four files of `localStorage` plus one canvas module. Extracting a core is the
  smallest change that guarantees one implementation of the protocol, and the protocol is the part
  where a second implementation would be dangerous rather than merely duplicative (§5B).
- Ink is the only candidate **verified to render under this repo's runtime** (Bun 1.4.0, in a pty)
  **[probe]**, it is actively published (7.1.1, July 2026 [NPM-INK]), and its component model maps
  directly onto the state the webapp already computes in hooks — a conversation list, a message pane
  with expiry timers, an input. The React dependency is the only real cost, and it is a devDependency
  of the CLI, not of the served bundle.
- OpenTUI is the more capable choice and the one that could make inline images cheap, but it adds an
  FFI-native dependency across eight platform packages with an explicit caveat that artifact
  availability "does not prove runtime parity on every published target" [OPENTUI-RUNTIME], and my
  renderer smoke test in a synthetic pty was inconclusive. It is the right thing to revisit once the
  client works; it is the wrong thing to bet the first version on.
- Push, QR scanning and image compression are deliberately out of the first version: the first two
  have no terminal equivalent, and the third has a one-line honest fallback ("resize it first").

## 7. Implementation outline

1. **Extract `src/core/`.** Move `crypto.ts`, `hex.ts`, `message-envelope.ts`, `encryption-key.ts`
   and `errors.ts` out of `src/client/lib`. Change `api.ts` to take `{ baseUrl, fetch }` instead of
   reading `window.location.origin` (`api.ts:78,109`) and to report auth expiry through an injected
   callback instead of `dispatchEvent` (`api.ts:48`). Define `IdentityStore` and `SessionStore`
   interfaces around what `burner.ts:43-57` and `session.ts:12-70` already do. Webapp keeps its
   `localStorage` implementations; no behaviour change, and the existing tests should pass untouched.
2. **Add `tsconfig.cli.json`** (no `DOM` lib, `types: ["bun-types"]`), reference it from
   `tsconfig.json:13-16`, and extend the `typecheck` and `lint` scripts to cover `src/cli`.
3. **Transport adapter.** A `fetch`-based SSE reader: read `response.body`, decode, split frames on
   `\n\n` and lines on `\n`, dispatch `ping`/`message`/`user:disconnected`. Feed it into the existing
   `SseConnection` through its `createEventSource` seam (`sse-connection.ts:35`) so the tested
   backoff state machine is reused rather than rewritten.
4. **File-backed stores.** `~/.config/0xchat/` at `0700`, `identity.json` and `session.json` at
   `0600`, re-asserted on write; refuse to start on loose permissions; import accepts a hex key on
   stdin, matching the webapp's export format (`KeyManagement.tsx:27,55`).
5. **Headless client first.** `0xchat whoami`, `0xchat register`, `0xchat send <addr> <text>
   --ttl 300`, `0xchat listen`, `0xchat qr` — each one a direct exercise of §1, testable without a
   terminal. This is essentially the probe script from §1.7 turned into a program.
6. **Then the Ink TUI**: conversation list (from `/api/conversations` plus local labels), message
   pane (first page + SSE, with the `verifyDeliveredMessage` check kept,
   `src/shared/message-envelope.ts:125-131`), a TTL picker restricted to `VALID_TTLS`
   (`constants.ts:43`), per-message expiry countdowns (§4.4), and a status line showing stream
   state, since a CLI has no browser tab to imply connectivity.
7. **Image receive**, in two steps: placeholder line plus `--out` first; kitty-protocol rendering
   behind a runtime capability query (`a=q` + device attributes [KITTY-GFX]) second. Image *send*
   reuses `compressionAttempts` (`image.ts:29-43`) if and when an encoder is chosen; until then,
   reject over `MAX_DATA_URL_LENGTH` with a clear message.
8. **Tests**: reuse `src/shared/message-envelope.test.ts:52-53`'s fixed vector as the core's
   conformance test; add an integration test that runs the §1.7 flow against a server started on an
   ephemeral port, which is the check that a wire-contract regression would actually catch.

Open questions worth settling before step 6: whether the CLI should count against the same 3-stream
cap as the user's browser (`constants.ts:48`) or whether that cap should rise; and whether the CLI
should implement the unimplemented expiry semantics in `docs/domain-behavior.md` (it should not —
until the server does).

---

## Sources

Repository files are cited inline as `path:line` against `main` at `b4277a0`.

Probes (**[probe]**) were run on 2026-09-07 with Bun 1.4.0 on Linux x64 against `server.ts` at
`b4277a0`: (a) a runtime-capability script (WebCrypto HKDF/AES-GCM round trip, `viem` sign/recover,
33-byte ECDH secret, `EventSource`/`localStorage`/`indexedDB`/`Notification` globals, `node:tty`,
`setRawMode`, `isTTY`, `XDG_CONFIG_HOME`, `0700`/`0600` file modes); (b) an end-to-end client script
(register ×2, session ×2, SSE over `fetch`, send, live receive, decrypt, backfill, conversations,
SSE-token reuse) against a server on port 3999 with a database outside the repo; (c) TUI probes in a
scratch directory (`ink@7.1.1` + `react@19.2.8` rendered in a pty; `@opentui/core@0.5.10` installed
and imported). All probe scripts were deleted afterwards; `git status` was clean before and after.

External:

- [BUN-WEBAPI] Bun docs, "Web APIs" — Fetch/Request/Response/Headers, TextEncoder/TextDecoder,
  WebSocket, Crypto/SubtleCrypto/CryptoKey, Streams, EventTarget/Event.
  https://bun.com/docs/runtime/web-apis
- [BUN-GLOBALS] Bun docs, "Globals" — `crypto`, `Crypto`, `SubtleCrypto` listed as Web globals; no
  `EventSource` and no `localStorage` entry. https://bun.com/docs/runtime/globals
- [NODE-TTY] Node.js docs, `tty` — `readStream.setRawMode(mode)` ("input is always available
  character-by-character… echoing input characters… Ctrl+C will no longer cause a SIGINT"), the
  `'resize'` event, `writeStream.columns`/`rows`. https://nodejs.org/api/tty.html
- [INK] Ink README — "It uses Yoga to build Flexbox layouts in the terminal"; `useInput`;
  `useStdin().isRawModeSupported`; `setRawMode`. https://github.com/vadimdemedes/ink
- [INK-650] vadimdemedes/ink issue #650, "\"react-devtools-core\" is not found" (13 March 2024,
  closed as not planned) — the historic Bun resolution failure.
  https://github.com/vadimdemedes/ink/issues/650
- [OPENTUI-README] OpenTUI README — Zig core with TypeScript/React/Solid bindings; flexbox boxes,
  selects, inputs, scroll boxes, keyboard and mouse; images and 3D; powers OpenCode.
  https://github.com/anomalyco/opentui
- [OPENTUI-RUNTIME] OpenTUI docs, "Runtime and platform support" — "Bun 1.3.0 or later" (1.4.0+ on
  Windows arm64), "Node.js 26.4.0 or later" with ESM and `--experimental-ffi`, eight native
  packages, "An available artifact does not prove runtime parity on every published target",
  `OPENTUI_LIBC`. https://opentui.com/docs/getting-started/runtime-support
- [CLACK] @clack/prompts README — "an opinionated, pre-styled wrapper around `@clack/core`";
  individual prompt components (text, select, multiselect, spinner, progress).
  https://github.com/bombshell-dev/clack/tree/main/packages/prompts
- [TEXTUAL] Textual documentation — "a _Rapid Application Development_ framework for Python"; apps
  run in the terminal or a browser, and over SSH. https://textual.textualize.io/
- [KITTY-GFX] kitty graphics protocol — APC escape format `<ESC>_G<control data>;<payload><ESC>\`,
  24-bit RGB / 32-bit RGBA / PNG, 4096-byte chunks, implementations (Ghostty, Konsole, st patched,
  Warp, wayst, WezTerm, iTerm2, xterm.js), "most terminal emulators ignore APC codes", `a=q`
  capability query. https://sw.kovidgoyal.net/kitty/graphics-protocol/
- [ITERM2-IMG] iTerm2 documentation, "Inline Images Protocol" — `ESC ] 1337 ; File = … : base64 ^G`,
  `MultipartFile`/`FilePart`/`FileEnd` for tmux 3.5+, 1,048,576-byte limit, any format macOS decodes.
  https://iterm2.com/documentation-images.html
- [VT340-SIXEL] DEC VT330/VT340 Programmer Reference Manual, Chapter 14, "Graphics Programming" —
  a sixel is "a group of six pixels in a vertical column"; `DCS P1;P2;P3 q s…s ST`.
  https://www.vt100.net/docs/vt3xx-gp/chapter14.html
- [QRCODE] node-qrcode README — `QRCode.toString(text, { type: 'terminal' })`; `small`: "Relevant
  only for terminal renderer. Outputs smaller QR code."
  https://github.com/soldair/node-qrcode
- [NPM-REGISTRY] npm registry API, queried 2026-09-07 — versions, publish dates, licenses and
  `engines` for `@opentui/core` (0.5.10, 2026-09-01), `ink` ([NPM-INK] 7.1.1, 2026-07-16,
  `node >= 22`), `blessed` ([NPM-BLESSED] 0.1.81, 2015-09-03), `neo-blessed` ([NPM-NEO-BLESSED]
  0.2.0, 2018-06-13), `terminal-kit` (3.1.4, 2026-07-19, `node >= 16.13.0`), `@clack/prompts`
  (1.7.0, 2026-07-03, `node >= 20.12.0`). https://registry.npmjs.org/
