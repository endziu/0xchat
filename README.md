# 0xChat

0xChat is a pseudonymous, end-to-end encrypted chat app where an Ethereum address is your identity. There is no signup, email address, phone number, username, friend request, or wallet connection.

Open the app and it creates a fresh **burner identity** in your browser. Share its address or QR code, start a conversation with another registered address, and choose how long each message should exist—from 5 seconds to 24 hours.

> **Important:** your private key is your account. Export it if you want to keep the identity. Losing browser storage without a backup means losing access permanently. Use a dedicated burner key; do not import a wallet that holds valuable assets.

## What 0xChat does

- Creates and registers an Ethereum-compatible burner identity automatically.
- Lets people contact each other directly by address or QR code.
- Encrypts and signs messages in the browser before sending them.
- Delivers messages live and can send optional, content-free push alerts.
- Deletes messages after the sender-selected expiry time, or right away when either side clears the conversation.
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

## Terminal client

Create a CLI identity on `https://chat.endziu.xyz` and open a conversation:

```sh
bun run cli --server prod init
bun run cli --server prod chat 0xYOUR_CONVERSATION_PARTNERS_ADDRESS
```

For local development, start `bun run dev` and use `--server local` (the default,
`http://localhost:3000`). Set `OXCHAT_SERVER=prod` to use production by default,
or pass `--server ORIGIN` for a custom server. If `init` saved an identity but
could not connect, retry with `bun run cli --server prod register` or
`bun run cli --server local register` once the local server is running.

The CLI supports
encrypted text chat with browser identities, live updates, key import/export,
and scriptable send/read commands with JSON output. See [the CLI guide](docs/cli.md)
or `bun run cli --help`.

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
| `RECIPIENT_OPENING` | unset | Set to `1` or `true` to activate opening-based message expiry and require updated clients. Follow the [staged enablement and rollback](docs/message-opening-api.md#release-gate) steps |
| `TRUSTED_PROXY_IPS` | unset | Comma-separated, unscoped IPs of your reverse proxy/edge (IPv6 zone identifiers are rejected). When the direct peer is in this list, the client IP is taken from the rightmost untrusted `X-Forwarded-For` hop; otherwise `X-Forwarded-For` is ignored |

Generate a VAPID pair with:

```sh
bunx web-push generate-vapid-keys
```

Copy the generated values into `.env`. Rotating the pair invalidates existing browser push subscriptions; each browser recovers when its user clicks **Enable notifications** again. Missing keys do not stop the server; they soft-disable push support.

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

## Rate limits

All limits are per minute. Each operation has its own budget, so one never
consumes another's.

| Operation | Per identity | Per IP |
|---|---:|---:|
| Send message | 120 (per IP + identity) | 240 |
| Open messages | 120 (across devices and networks) | 240 |
| Recover messages (initial and continuation pages) | 120 | 240 |
| Lifecycle state lookup | 120 | 240 |
| Clear conversation | 10 | 20 |
| Push subscription changes | 10 (per IP + identity) | — |
| Registration challenge, registration, auth challenge, auth session, SSE token | — | 10 each |

The per-IP message cap gives two identities that share an IP their full individual
allowance while still putting a ceiling on identity cycling. Opening and state
lookup take 1–100 distinct IDs per request with an 8 KiB body limit. See
[the opening contract](docs/message-opening-api.md) and
[the recovery contract](docs/message-recovery-api.md).

## Retention

- Messages are deleted when they expire (see
  [domain behavior](docs/domain-behavior.md)) or when either participant clears the
  conversation (`DELETE /api/messages/:address`).
- Public-key registrations are pruned after 30 days without a new session or a
  sent or received message. Re-registering an existing key alone does not extend
  the window. A pruned recipient cannot receive messages
  (`Recipient not registered`) until they register again.
- Cleanup runs every 30 seconds.

## Push notifications

Push alerts are content-free wake-ups. Enabling is always an explicit click.
Each identity can have up to five notification slots (one per browser). An alert
can wake an offline recipient until a deadline fixed when the message is accepted:
its expiry for legacy messages, or 24 hours later under recipient opening.
When a push service reports an endpoint dead (404/410/401/403), the slot is marked
as needing repair and the user enables notifications again in that browser. The
endpoints are `GET /api/push/subscriptions` and `POST /api/push/{subscribe,reconcile,unsubscribe}`,
all authenticated with the identity's session.

---
