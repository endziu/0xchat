# 0xChat

0xChat is a pseudonymous, end-to-end encrypted chat app where an Ethereum address is your identity. There is no signup, email address, phone number, username, friend request, or wallet connection.

Open the app and it creates a fresh **burner identity** in your browser. Share its address or QR code, start a conversation with another registered address, and choose how long each message should exist—from 5 seconds to 24 hours.

> **Important:** your private key is your account. Export it if you want to keep the identity. Losing browser storage without a backup means losing access permanently. Use a dedicated burner key; do not import a wallet that holds valuable assets.

## What 0xChat does

- Creates and registers an Ethereum-compatible burner identity automatically.
- Lets people contact each other directly by address or QR code.
- Encrypts and signs messages in the browser before sending them.
- Delivers messages live and can send optional, content-free push alerts.
- Deletes messages after the sender-selected expiry time.
- Supports text and encrypted image attachments.
- Works as an installable PWA on mobile and desktop.
- Lets you export/import your identity and delete your account.

0xChat uses Ethereum cryptography and address formatting, but chatting is **not an onchain transaction**. It does not require a wallet extension, network connection, tokens, or gas.

---

# Running the repository

## Requirements

- [Bun](https://bun.sh/)
- A modern browser with Web Crypto support
- HTTPS for production PWA, camera, and notification behavior

SQLite is built into Bun; no separate database server is required.

## Install

```sh
git clone https://github.com/endziu/0xchat.git
cd 0xchat
bun install
cp .env.example .env
```

The default environment is enough for local chat. Push notifications remain disabled until VAPID keys are configured.

## Development

```sh
bun run dev
```

This starts both:

- the Bun API server on `http://localhost:3000`; and
- the Vite development server, which proxies `/api` to port 3000.

Open the URL printed by Vite. Debug logging is enabled by the development script.

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3000` | Bun server port |
| `DEBUG` | unset | Set to `1` or `true` for verbose server logs |
| `VAPID_PUBLIC_KEY` | empty | Web Push public key |
| `VAPID_PRIVATE_KEY` | empty | Web Push private key |
| `VAPID_SUBJECT` | mailto value | VAPID contact URI, normally `mailto:you@example.com` |
| `TRUSTED_PROXY_IPS` | unset | Comma-separated, unscoped IPs of your reverse proxy/edge (IPv6 zone identifiers are rejected). When the direct peer is in this list, the client IP is taken from the rightmost untrusted `X-Forwarded-For` hop; otherwise `X-Forwarded-For` is ignored |

Generate a VAPID pair with:

```sh
bunx web-push generate-vapid-keys
```

Copy the generated values into `.env`. Rotating the pair invalidates existing browser push subscriptions. Missing keys do not stop the server; they soft-disable push support.

## Build and run

Build the frontend into `dist/`:

```sh
bun run build
```

Run an already-built production server:

```sh
bun run start:prod
```

For a clean local demonstration—delete the database, rebuild, and start with debug logs:

```sh
bun run start
```

`start` is destructive to the local database. Use `start:prod` when existing data must be preserved.

## Checks

Run the fast required checks before considering a change complete:

```sh
bun run typecheck
bun run lint
```

Run the full test command:

```sh
bun run test
```

The full command deletes the local database and `dist/`, builds the app, then runs `bun test`. It is intentionally destructive and slower than the individual checks.

## All repository commands

```sh
bun install          # install dependencies
bun run dev          # start Vite + backend with debug logs
bun run build        # build frontend SPA into dist/
bun run icons        # regenerate public icons and favicon
bun run start        # clear db, build, start server with debug logs
bun run start:prod   # start server using an existing dist/
bun run clear:db     # delete chat.db and WAL/SHM files only
bun run clear:dist   # delete dist/ only
bun run clear:all    # delete database files and dist/
bun run typecheck    # TypeScript checks without emitting files
bun run lint         # lint src and server.ts
bun run test         # clear all, build, then run Bun tests
```

Runtime data is stored in `chat.db` beside the project. The database, build output, dependencies, and `.env` are ignored by Git.

Message submissions are limited to 120 per minute per IP/address pair and 240 per
minute across all addresses on one IP. The aggregate cap allows two identities
sharing an IP their full individual allowance while placing a fixed ceiling on
identity cycling. Registration writes are limited to 10 per minute per IP.

Public-key registrations are pruned after 30 days without a new session or a sent
or received message. Initial registration starts the retention window;
re-registering an existing key alone does not extend it. Existing databases get
a fresh 30-day window on migration. Cleanup runs every 30 seconds. A pruned
recipient cannot receive messages (`Recipient not registered`) until they
register again. New sessions store addresses in lowercase, consistently with
public-key lookups and authenticated message addresses.
Public-key registrations with no session or message activity are pruned after 30 days.

---
