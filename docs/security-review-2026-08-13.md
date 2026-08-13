# Security Review — 2026-08-13

The code is not ready to claim authenticated E2E security. The primitives work, but the protocol
lets a compromised server read or forge messages. This review found five high-severity and one
medium-severity security issue.

## Scope

Full codebase at commit `2852e0b`, with emphasis on cryptography, identity and session boundaries,
and the dependency supply chain.

## Spec and security findings

### 1. High — server-assisted MITM and message forgery

Encryption uses ECDH/HKDF/AES-GCM correctly, but the envelope has no sender signature and no
authenticated metadata. Recipient keys are fetched from the server without verifying that the key
derives the requested Ethereum address.

A malicious server can substitute its own public key, decrypt the sender's message, re-encrypt it
for the real recipient, or fabricate a new ciphertext and label it as coming from anyone.

Evidence:

- `src/client/lib/crypto.ts:18`
- `src/client/hooks/useMessages.ts:37`
- `src/server/routes/messages.ts:85`

Recommended fix: verify compressed public key to Ethereum address, sign a canonical message
envelope, and authenticate sender, recipient, version, TTL, and a client-generated message ID using
signatures and AES-GCM AAD.

### 2. High — registration does not bind the encryption key

The signed challenge contains only address and nonce. The submitted public key is only
length-checked, not validated as a curve point or checked against the Ethereum address. It is then
accepted with `INSERT OR REPLACE`.

Evidence:

- `src/server/routes/register.ts:26`
- `src/server/routes/register.ts:48`
- `src/server/db.ts:57`

Recommended fix: include the public key and protocol/origin context in the signed challenge, parse
it as a valid secp256k1 point, and reject it unless its derived Ethereum address matches the claimed
address.

### 3. High — URL fragment silently replaces the private identity

Any URL ending in `#<64 hex characters>` imports that private key without confirmation, overwriting
the current identity. An attacker can send a link that fixes the victim to an attacker-known key,
exposing later messages and potentially losing the victim's previous identity.

Evidence:

- `src/client/components/App.tsx:58`
- `src/client/hooks/useIdentity.ts:114`

Recommended fix: remove this flow or restrict it to an explicit import route with confirmation.
Erase the fragment immediately using `history.replaceState` before processing it.

### 4. High — imported identity retains the previous account's session

Import changes the cryptographic identity but `useSession` keeps the old bearer token. The UI can
therefore show identity B while requests authenticate as account A. Messages and account deletion
can execute against the wrong account.

Evidence:

- `src/client/components/KeyManagement.tsx:33`
- `src/client/hooks/useSession.ts:6`
- `src/client/lib/api.ts:23`

Recommended fix: unsubscribe push, clear the session, switch identity, and obtain a fresh session
as one atomic operation. Associate stored tokens with their address.

### 5. High for developer/build systems — known-vulnerable dependency graph

`bun audit --json` reported 25 advisories across eight packages: 1 critical, 8 high, 13 moderate,
and 3 low. Notable chains include:

- `concurrently -> shell-quote@1.8.3`: critical command-injection advisory.
- `vite@5.4.14 -> esbuild/postcss/nanoid`: multiple file-read, traversal, and denial-of-service
  advisories.
- `@preact/preset-vite -> picomatch@2.3.1`: ReDoS.
- `viem -> ws@8.18.3`: memory disclosure/exhaustion advisories.

Evidence:

- `package.json:27`
- `bun.lock:299`
- `bun.lock:419`
- `bun.lock:441`
- `bun.lock:445`
- `bun.lock:495`

Most vulnerable modules are build/dev-only or not reached by the current client and server bundles,
reducing direct production exploitability. Vite still handles source files on developer machines,
and the shipped client bundle controls private keys.

Positive controls: all 255 locked packages have integrity hashes, frozen installation succeeds, and
there are no Git/file dependencies. Missing controls include automated auditing, an update policy,
minimum package age, and explicit trusted lifecycle dependencies.

### 6. Medium — registration challenge memory exhaustion

`/api/register/challenge` is unauthenticated and lacks the rate limit applied to authentication
challenges. Requests for unique addresses grow both challenge maps until cleanup, permitting memory
exhaustion.

Evidence:

- `src/server/routes/register.ts:12`
- `src/server/challenge.ts:12`

## Standards findings

### Hard violations

- Message hex is stripped before DB storage and SSE emission, contrary to the documented `0x`
  invariant (`src/server/routes/messages.ts:37`).
- `notFound()` constructs JSON instead of using `json()` (`src/server/router.ts:67`).
- Push unsubscribe performs ad-hoc validation instead of using `validation.ts`
  (`src/server/routes/push.ts:48`).
- Boot logging bypasses the shared logger (`server.ts:29`).
- Three mobile controls use the specifically prohibited `p-0.5` sizing.

### Judgement calls

- The six raw crypto-envelope strings form a security-sensitive data clump. Typed
  `EncryptedEnvelope`, `Address`, and `Hex` values would centralize invariants.
- HKDF derivation is duplicated between encryption and decryption, increasing protocol-drift risk.

## Verification

- Typecheck and lint passed.
- Production Vite build passed.
- Full isolated suite: 48 passed, 0 failed.
- Crypto round-trip passed; modified ciphertext was rejected by AES-GCM.
- The review did not modify application code.

## Summary

Standards: 5 hard violations and 2 heuristic findings. Spec/security: 5 high and 1 medium. The worst
standards issue is the broken hex representation invariant. The worst security issue is that the
server can intercept or forge messages despite the E2E claim.
