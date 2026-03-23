# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun install          # install deps
bun run build        # build frontend SPA (Vite)
bun run start        # build + start server (foreground)
bun run clear        # delete chat.db and WAL/SHM files
bun run typecheck    # tsc --noEmit
bun run lint         # oxlint src server.ts
bun run test         # bun test
```

## Project

**ETH-Chat** — a Preact-based E2E encrypted ephemeral chat between Ethereum addresses using auto-generated **Burner Wallets**.

- **Frontend:** Preact SPA, Tailwind CSS v4, Vite.
- **Identity:** Burner keypairs generated locally and stored in `localStorage`.
- **Encryption:** Messages are double-encrypted (once for recipient, once for sender) using ECIES (AES-GCM-256).
- **Delivery:** Real-time delivery via SSE (Server-Sent Events).
- **Backend:** Bun HTTP server + SQLite (`bun:sqlite`).

## Source Layout

```
server.ts                         Backend entry point (Bun.serve)
server.test.ts                    HTTP integration tests
index.html                        SPA entry point
vite.config.ts                    Frontend build config
src/
  server/
    db.ts                         SQLite schema + CRUD
    sse.ts                        SSE client tracking + push
    rate-limit.ts                 In-memory rate limiter
    verify.ts                     EIP-191 signature recovery (viem)
  client/
    main.tsx                      Preact entry point
    styles.css                    Tailwind v4 entry point
    lib/
      burner.ts                   Key generation, storage, EIP-191 signing
      crypto.ts                   ECIES encrypt/decrypt (Web Crypto API)
      api.ts                      Typed API client
      session.ts                  Bearer token storage
    hooks/
      useIdentity.ts              Local account lifecycle
      useSession.ts               Auth token management
      useConversations.ts         Conversation list management
      useMessages.ts              Message loading/decryption/sending
      useSSE.ts                   SSE listener lifecycle
    components/
      App.tsx                     Root router & layout wrapper
      ChatView.tsx                Main chat interface
      MessagePane.tsx             Message bubbles & input (supports image paste)
      ConversationList.tsx        Sidebar contacts
      OnboardingView.tsx          First-time burner generation
      KeyManagement.tsx           Key export/import settings
```

## Architecture

**Identity & Registration:**
- Unique secp256k1 keypair is generated on first visit and stored in `localStorage`.
- To receive messages, users `POST /api/register` with their address, public key, and an EIP-191 signature of `"ETH-Gate keypair v1"`.

**Session Authentication:**
- `POST /api/auth/challenge { address }` → returns a unique challenge + nonce.
- Client signs challenge → `POST /api/auth/session` → returns 24h bearer token.
- Token is sent in `Authorization: Bearer <token>` headers. 401 errors trigger local token clearing.

**Message flow:**
- Sender encrypts plaintext twice: ECIES with recipient pubkey + ECIES with own pubkey.
- `POST /api/messages` with ciphertexts, ephemeral keys, and IVs.
- Server stores message, notifies both parties via SSE.
- Clients decrypt their respective ciphertext using their private key.
- Supports image pasting: images are converted to data URLs and encrypted as text.

**Expiry:**
- Messages auto-delete after TTL (30s, 5m, 1h, 24h).
- Server cleans DB every 30s; client removes messages from state via timers or refreshes.

## Crypto Scheme

- **Key Derivation:** `crypto.getRandomValues(32)` for raw entropy.
- **Encryption:** ECIES — ephemeral ECDH + HKDF-SHA-256 + AES-GCM-256.
- **Standards:** All hex strings in API/DB use the `0x` prefix for compatibility with `viem`.
- **Library:** `@noble/secp256k1` (v3) for curve math, `viem` for addresses/signatures.

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/*` | - | Serves `dist/` or `index.html` (SPA fallback) |
| POST | `/api/register` | - | Register pubkey for an address |
| GET | `/api/pubkey/:addr` | - | Lookup a registered pubkey (returns null if not found) |
| POST | `/api/auth/challenge`| - | Issue unique auth challenge |
| POST | `/api/auth/session` | - | Verify sig → return bearer token |
| POST | `/api/messages` | Bearer | Send double-encrypted message/image |
| GET | `/api/messages/:addr`| Bearer | Fetch conversation history (reversed for UI) |
| GET | `/api/conversations`| Bearer | List active conversations |
| GET | `/api/events` | Token | SSE event stream |
