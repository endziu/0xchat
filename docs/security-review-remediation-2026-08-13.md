# Security Review Remediation — 2026-08-13

This report summarizes remediation of findings from [Security Review — 2026-08-13](security-review-2026-08-13.md), reviewed against `main` at `0e2af41`.

## Security findings

| # | Finding | Status | Remediation |
|---|---|---|---|
| 1 | Server-assisted MITM and message forgery | Fixed | Added versioned, typed message envelopes with client-generated IDs. Sender, recipient, TTL, version, and ID are authenticated as AES-GCM AAD; complete envelopes are signed and verified by the server and clients. Duplicate IDs are rejected. (`990980a`) |
| 2 | Registration key not bound to identity | Fixed | Registration challenges now bind origin, address, public key, and nonce. Public keys must be valid compressed secp256k1 points deriving the claimed Ethereum address. (`cfdf937`, `79ac5f1`) |
| 3 | URL fragment silently replaces identity | Fixed | Fragment key import was removed. Any fragment is erased before application startup with `history.replaceState`; regression tests cover fragment rejection. (`19f32f4`) |
| 4 | Imported identity retains old session | Fixed | Identity switching now unsubscribes push, clears old authentication, prepares the new identity, creates a fresh session, and commits identity/token together. Stored sessions are address-bound and stale async attempts cannot commit. (`2172d29`) |
| 5 | Vulnerable dependency graph | Fixed | Vulnerable direct and transitive dependencies were upgraded, including Vite, concurrently, viem, and the Vite plugin stack. Current `bun audit --json` returns no advisories. (`997fb74`) |
| 6 | Registration challenge memory exhaustion | Fixed | Registration challenge issuance is IP-rate-limited. The shared challenge store also enforces one entry per subject, expiry, and a 10,000-entry hard cap with eviction. (`cfdf937`) |

## Standards findings

The message hex invariant is restored by typed `0x`-prefixed envelopes. The crypto envelope data clump is represented by shared types and centralized parsers, canonicalization, and verification. HKDF derivation is centralized in `deriveAesKey`.

Four non-security hard violations remain open: `notFound()` does not use `json()`, push-unsubscribe validation remains local, boot logging uses `console.log`, and three controls still use `p-0.5`.

## Verification

Remediation added focused tests for fragment handling, identity transitions, address-bound sessions and registration, challenge limits, envelope parsing/signatures/AAD, replay rejection, and message persistence. Current dependency audit reports zero advisories.
