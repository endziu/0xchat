# Test Coverage Report

**Measured:** 2026-08-14  
**Command:** `bun test --coverage`  
**Result:** 81 passed, 0 failed; 302 assertions across 13 test files

## Summary

Bun reports:

| Metric | Coverage |
|---|---:|
| Lines | 73.40% |
| Functions | 70.42% |

These percentages overstate whole-application coverage. Bun only instrumented 19 of 46 production TypeScript/TSX files. The HTTP integration suite starts the server in a child process, so executed server routes are not represented in the parent test process's coverage report. Conversely, most client hooks and components are neither instrumented nor tested.

A more useful risk-weighted estimate of overall automated coverage is **45–55%**. This is an engineering estimate, not a directly measured line percentage.

## Coverage by area

### Shared cryptographic protocol: strong (~90–100%)

Well covered:

- Canonical message metadata and envelope encoding
- Signing and signature verification
- Encryption/decryption vectors
- Mutation and wrong-signer rejection
- Encryption public-key ownership checks
- Registration challenge encoding

This is the strongest part of the suite and covers the application's highest-risk message-integrity behavior.

### Server database and core utilities: good (~70–85%)

Well covered:

- Public-key registration and lookup
- Session creation, lookup, expiry, and deletion
- Message persistence, expiry, pagination, and conversation direction
- Legacy-message hard cutover
- Account-data cascade primitives
- Challenge expiry, replay prevention, and bounded storage
- SSE client tracking and notification
- Rate-limit boundaries and isolation

Remaining gaps include less common database/error branches and cleanup behavior outside the directly tested paths.

### HTTP routes: moderate

The integration suite covers:

- Static SPA responses and CSP
- Public-key lookup
- Registration success and important rejection cases
- Auth challenge and invalid session nonce
- Authenticated conversation listing
- Message persistence, fetch, SSE delivery, verification, and decryption
- Forgery, replay, recipient/sender mutation, and legacy-version rejection

Important gaps:

- Successful auth-session issuance
- Account-deletion route behavior and partner notifications
- Most event-token and SSE authorization/error paths
- Push VAPID-key, subscribe, unsubscribe, delivery, dead-subscription pruning, and SSRF protections
- Broader malformed-body, unauthorized, expiry, pagination, and boundary cases

Because the server runs in a subprocess, Bun does not attribute this integration execution to route source files. Route coverage is therefore better than the raw report suggests, but still incomplete.

### Client libraries: mixed

Strong coverage:

- Cryptography
- Envelope construction
- Encryption-key validation
- Identity transition ordering and failure handling
- Identity-bound session storage

Weak or partial coverage:

- General API client methods and error handling
- Burner-key generation, persistence, export, and import
- Contact storage, deletion markers, and last-seen state

### Client hooks and components: effectively untested

There is no meaningful automated coverage for:

- Identity/session initialization hooks
- Conversation merging and unread state
- Message loading, decryption, expiry timers, and sending
- SSE lifecycle and reconnect behavior
- Push subscription lifecycle
- Install-prompt behavior
- Chat, conversation list, key management, QR, layout, toast, and message composer components

This is the largest coverage gap. Regressions in UI state transitions, touch behavior, accessibility, and browser API integration are unlikely to be caught by the current suite.

### Browser and PWA behavior: effectively untested

The suite does not exercise the application in a real browser. Missing coverage includes:

- Service-worker installation, caching, update, push, and notification-click behavior
- Confirmation that `/api/*` responses never enter the cache
- Indexed browser APIs, permissions, camera/QR scanning, clipboard/image paste, and install prompts
- Mobile touch targets, two-tap destructive actions, hover affordances, and safe areas
- End-to-end identity import and messaging through the rendered UI

## Assessment

The suite gives good confidence in the cryptographic message protocol, core persistence, and the main message transport path. Those tests are valuable and target several security-sensitive invariants.

The reported 73.40% line coverage should not be used as the repository-wide coverage figure because untouched files are omitted and subprocess execution is not collected. Overall confidence is **moderate**, with an estimated **45–55% risk-weighted coverage**.

The main exposure is client behavior, push notifications, account deletion, browser/PWA integration, and route error handling.

## Recommended priorities

1. Add route integration tests for account deletion, event tokens, and every push endpoint.
2. Test push host validation, payload-less delivery, TTL forwarding, and 404/410 pruning.
3. Add client tests for contacts, API error handling, burner storage, and message/conversation hooks.
4. Add component tests for destructive confirmations, unread state, identity import, and message sending.
5. Add a small browser E2E suite covering registration, authentication, two-party messaging, expiry, account deletion, and service-worker API-cache exclusion.
6. Collect child-process server coverage or run the server through an in-process test harness so route metrics become trustworthy.
7. Configure coverage thresholds only after all production files are included in the denominator; start with layer-specific thresholds rather than one global percentage.
