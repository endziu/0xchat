# Code Review — 2026-08-30

Full-codebase review at commit `66eefa4`, focused on security, UX, code quality, and code
structure. Overall verdict: well-built. Envelope signing verified on both ends, AAD-bound
metadata, SSRF allowlist on push endpoints, single-use SSE tokens, fragment-clearing plus a
hash-pinned CSP are all sound. Findings are mostly at the edges, ranked by severity per axis.

## Scope

All of `src/`, `server.ts`, `public/sw.js`, `index.html` (~5,300 lines). No code changed.

## Security findings

### S1. High — rate limiting breaks behind a reverse proxy

`getClientIp` uses only `server.requestIP` (`src/server/http.ts:22`). Production requires HTTPS
(PWA, camera, notifications), so the server sits behind a proxy — every client then shares the
proxy's IP. Result: 10 auth/register requests per minute for the entire userbase, and one hostile
user can 429-lock everyone out of login.

Fix: trusted-proxy `X-Forwarded-For` parsing, gated by explicit config, never trusted blindly.

### S2. Medium — session tokens stored plaintext in SQLite

`createSession`/`getSession` (`src/server/db.ts:89-116`) store the raw bearer token. Anyone who
reads `chat.db` (backup, host compromise) gets valid 24h tokens.

Fix: store `sha256(token)`, hash on lookup.

### S3. Medium — no server-side session revocation

`clearToken()` is local-only; after identity import/switch the old token stays valid up to 24h.
Only full account deletion deletes sessions.

Fix: small `DELETE /api/session` endpoint, called on logout and identity transition.

### S4. Low/Medium — SSE resource exhaustion and slow cleanup

- `POST /api/events/token` has no rate limit; SSE connections per address are unbounded.
- Disconnect cleanup relies on the 30s heartbeat because `cancel()` is empty
  (`src/server/routes/events.ts:73`); the `ctrl.close` monkey-patch never fires for
  client-initiated disconnects.

Fix: rate-limit token minting; move cleanup into `cancel()` (also see Q5).

### S5. Low/Medium — storage DoS is cheap

Up to ~2×1MB ciphertext per message; rate-limit buckets are per `(ip, address)` and fresh
identities are free, so per-IP throughput is effectively unbounded. `pubkeys` grows forever with
no pruning of inactive addresses.

Fix: per-IP aggregate caps; prune pubkeys with no sessions/messages after a retention window.

### S6. Low — `?limit=abc` causes a 500

`Number('abc')` → NaN survives `Math.min/max` (`src/server/routes/messages.ts:114`); bun:sqlite
throws "datatype mismatch" (verified). Validate `limit` the way `before` is validated.

### S7. Low — CSP wider than needed

CSP allows `fonts.googleapis.com`/`fonts.gstatic.com` but `styles.css` loads no external fonts.
Trim both; consider adding `form-action 'self'` and a `Permissions-Policy` header
(`src/server/constants.ts:23`).

### S8. Low — auth challenge lacks origin binding

The registration challenge includes `Origin:` and the client verifies it; the session challenge
(`src/server/routes/auth.ts:35`) does not. Harmless today (nonces are server-scoped) but
inconsistent with the registration precedent.

### Positives

Envelope verification client- and server-side (`src/shared/message-envelope.ts`), AAD binds
metadata to ciphertext, replay guard via id primary key, push-endpoint host allowlist stops SSRF,
single-use short-lived SSE tokens keep bearer tokens out of URLs, fragment-clearing script is
CSP-hash-pinned, path-traversal guard on static files, pushes carry no payload.

## UX findings

### U1. High — 10 messages/min rate limit

`MAX_REQUESTS = 10` is one global constant for all limiters (`src/server/rate-limit.ts:4`).
A normal fast chat hits "Too many requests". Make limits per-route: messages much higher, auth low.

### U2. High — "Logout" permanently destroys the identity

`handleLogout` → `deleteAddress` + fresh keypair (`src/client/components/App.tsx:44`,
`src/client/hooks/useIdentity.ts:61`). The confirm is a red icon with "Click again to confirm" —
nothing says the account, key, and all conversations are deleted irrecoverably. Biggest data-loss
trap in the app. Name the consequence in the UI (or label the button "Burn identity").

### U3. Medium — photo attach exceeds the ciphertext cap with a cryptic error

No client-side downscale; a phone camera photo as dataURL blows the ~1MB cap and the server
rejects with "malformed message envelope" (`src/client/components/MessagePane.tsx:41`,
`src/shared/message-envelope.ts:79`). Compress via canvas before encrypting.

### U4. Medium — fetch errors are invisible

`useMessages`/`useConversations` catch → `console.error` only; a failed load renders as
"No messages yet", indistinguishable from an empty chat. Surface an error state.

### U5. Low — no history pagination

Server supports `before`/`limit` but the client never uses them — anything past the latest 50
messages is unreachable in the UI (`src/client/lib/api.ts:92`).

### Positives

Two-tap confirms, touch-visible action buttons, `aria-label`s throughout, viewport-aware composer
cap, offline shell, auto re-login on 401.

## Code quality findings

### Q1. Duplicated pubkey→address verification

`src/client/lib/encryption-key.ts` and `normalizeAddressBoundPubkey` in
`src/server/validation.ts:20` implement the identical algorithm with different shapes (throw vs
null). Move one copy to `src/shared/`.

### Q2. ChatView ref-handler duplication

Each SSE handler body is written twice — ref init and effect (`src/client/components/ChatView.tsx:28-54`).
A tiny `useLatest(fn)` helper removes both.

### Q3. App.tsx transition wiring is convoluted

Double-ref plus per-dep lambda wrappers (`src/client/components/App.tsx:18-40`); fold into a
custom hook.

### Q4. Dead exports (speculative generality)

`validation.isHex`, `validation.normalizeHex`, `sse.clientCount`, `sse.connectedAddresses` —
used only by tests or nothing.

### Q5. `ctrl.close` monkey-patch

`src/server/routes/events.ts:65-71` overrides the controller's `close`; fragile. Move cleanup
into `cancel()` (also fixes S4's slow cleanup).

### Q6. Mysterious leftovers

HKDF info `'ETH-Gate AES-GCM v1'` (`src/client/lib/crypto.ts:28`), `eth_chat_*` storage keys, in
an app now named 0xChat. Renaming the HKDF info is a protocol break — acceptable given ephemeral
messages, but do it deliberately with an envelope version bump.

### Q7. Minor

- `toast()` returns a cleanup nobody uses (`src/client/components/Toast.tsx:30`).
- `session.ts` module-global `activeAddress` is hidden coupling with the hooks.
- `rate-limit.ts` starts a `setInterval` at import time (testability).

## Code structure

Strongest part of the repo. Small single-purpose files, routes split per concern, and the crypto
seam is in the right place: `src/shared/message-envelope.ts` is verified by both server and
client, so the client never trusts the server's word on envelopes. Protocol core (crypto,
challenge, envelope, validation, rate-limit) has real tests.

Two structural suggestions:

1. Shared address/pubkey validation module in `src/shared/` (kills Q1).
2. A `RateLimiter` class instantiated per route with its own limits (kills U1 and the import-time
   interval in Q7 at once).
