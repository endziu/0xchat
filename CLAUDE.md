# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun install          # install deps
bun run build:crypto # bundle secp256k1 for browser (run once after install)
bun run build:wallet # bundle AppKit + wagmi for browser (run once after install, or after editing src/wallet-entry.ts)
bun run server       # start server (http://localhost:3000)
bun run typecheck    # tsc --noEmit
bun run lint         # oxlint src server.ts
bun run test         # bun test
```

## Project

**ETH-Chat** — an E2E encrypted ephemeral chat between Ethereum addresses. Messages are double-encrypted (once for recipient, once for sender) using ECIES. Real-time delivery via SSE. All messages have a TTL (30s, 5m, 1h, 24h) and auto-expire.

Backend: Bun HTTP server + SQLite (`bun:sqlite`). No framework, no server-side crypto.

## Source Layout

```
server.ts                         entry point (Bun.serve, all routes)
server.test.ts                    HTTP integration tests
src/
  crypto-entry.ts                 bundle entry — re-exports from @noble/secp256k1
  wallet-entry.ts                 bundle entry — AppKit + wagmi wallet module
  server/
    db.ts                         SQLite schema + CRUD (pubkeys, sessions, messages)
    db.test.ts                    DB unit tests
    rate-limit.ts                 in-memory sliding-window rate limiter
    rate-limit.test.ts            rate limiter unit tests
    verify.ts                     EIP-191 signature recovery via viem
    sse.ts                        SSE client tracking + push
    sse.test.ts                   SSE unit tests
    utils.js                      shared browser utilities (hexToBytes, bytesToHex, walletErrorMessage)
    utils.test.ts                 utils unit tests
    chat-crypto.js                ECIES encrypt/decrypt for browser
    chat-session.js               client auth (challenge → token)
    chat-client.js                chat UI logic + SSE listener
    secp256k1.bundle.js           generated browser bundle of @noble/secp256k1
    wallet.bundle.js              generated browser bundle of AppKit + wagmi
    views/
      register.html               one-time pubkey registration
      chat.html                   main chat UI
```

## Architecture

**Recipient registration (once):**
- Visits `GET /register` → connects wallet
- `personal_sign("ETH-Gate keypair v1")` → deterministic sig → SHA-256 → secp256k1 seed → compressed pubkey
- `POST /api/register { address, pubkey, sig }` → server verifies sig → stores pubkey

**Session auth:**
- `POST /api/auth/challenge { address }` → server issues nonce (5-min TTL)
- `personal_sign(challenge)` → `POST /api/auth/session` → server verifies, creates 24h bearer token
- Token stored in sessionStorage, sent as `Authorization: Bearer <token>`

**Message flow:**
- Sender encrypts plaintext twice: ECIES with recipient pubkey + ECIES with own pubkey
- `POST /api/messages` with both ciphertexts + TTL
- Server stores message, computes expires_at, notifies both parties via SSE
- Recipient/sender decrypts their respective ciphertext using derived seed

**Expiry:**
- Messages auto-deleted when `expires_at` passes (30s server cleanup interval)
- Client-side timers remove messages from DOM with CSS fade transition

## Crypto Scheme

- Key derivation: `SHA-256(personal_sign("ETH-Gate keypair v1"))` → 32-byte secp256k1 seed
- Encryption: ECIES — ephemeral ECDH + HKDF-SHA-256 + AES-GCM-256
- HKDF salt: ephemeral pubkey bytes (33-byte compressed)
- HKDF info: "ETH-Gate AES-GCM v1"
- secp256k1: `@noble/secp256k1` bundled for browser
- AES-GCM + HKDF: native Web Crypto API

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | - | Redirect to `/chat` |
| GET | `/register` | - | Registration page |
| GET | `/chat` | - | Chat UI |
| GET | `/chat/:address` | - | Chat UI (conversation with address) |
| GET | `/*.js` | - | Static JS bundles |
| POST | `/api/register` | - | Store pubkey for address |
| GET | `/api/pubkey/:address` | - | Lookup pubkey |
| POST | `/api/auth/challenge` | - | Issue session challenge |
| POST | `/api/auth/session` | - | Verify sig → bearer token |
| POST | `/api/messages` | Bearer | Send double-encrypted message |
| GET | `/api/messages/:address` | Bearer | Fetch conversation (paginated) |
| GET | `/api/conversations` | Bearer | List active conversations |
| GET | `/api/events` | Token (query) | SSE real-time stream |
