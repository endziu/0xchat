# 0xChat

0xChat is a pseudonymous, end-to-end encrypted chat app where an Ethereum address is your identity. There is no signup, email address, phone number, username, friend request, or wallet connection.

Open the app and it creates a fresh **burner identity** in your browser. Share its address or QR code, start a conversation with another registered address, and choose how long each message lasts once it is opened—from 5 seconds to 24 hours.

> **Important:** your private key is your account. Export it if you want to keep the identity. Losing browser storage without a backup means losing access permanently. Use a dedicated burner key; do not import a wallet that holds valuable assets.

## What 0xChat does

- Creates and registers an Ethereum-compatible burner identity automatically.
- Lets people contact each other directly by address or QR code.
- Encrypts and signs messages in the browser before sending them.
- Delivers messages live and can send optional, content-free push alerts.
- Deletes each message when its lifetime ends after the recipient opens it (or 24 hours after sending if it is never opened), or right away when either side clears the conversation.
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
bun run stats:dau    # read historical daily active identity totals from local chat.db (JSON)
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
| Attention update | 60 (per IP + identity) | — |
| Delete account | — | 10 |
| Push subscribe/unsubscribe | 10 (per IP + identity) | — |
| Registration challenge, registration, auth challenge, auth session, SSE token | — | 10 each |

The per-IP message cap gives two identities that share an IP their full individual
allowance while still putting a ceiling on identity cycling. Opening and state
lookup take 1–100 distinct IDs per request with an 8 KiB body limit. Every
request body is capped at 32 KiB; larger bodies get `413`. See
[the message lifecycle API](docs/message-lifecycle-api.md).

## Retention

- Messages are deleted when they expire (see
  [domain behavior](docs/domain-behavior.md)) or when either participant clears the
  conversation (`DELETE /api/messages/:address`).
- Public-key registrations are pruned after 30 days without a new session or a
  sent or received message. Re-registering an existing key alone does not extend
  the window. A pruned recipient cannot receive messages
  (`Recipient not registered`) until they register again.
- Cleanup runs every 30 seconds.

## Daily active identities

`bun run stats:dau` reads local `chat.db` in read-only mode and prints UTC daily
counts as JSON (`day`, `identities`). It requires filesystem access, not an HTTP
admin endpoint. Tracking begins when this version is deployed; there is no
backfill. Only days with activity appear, and today's count is provisional.

An identity counts once per UTC day when a browser explicitly reports foreground
attention (visible and focused), sends an accepted message, or opens an available
message. Foreground attention is refreshed by the existing 20-second heartbeat,
including across midnight. Authentication, passive delivery, background/terminal
connections, message recovery, and lifecycle-state lookups alone do not count.
These are distinct identities, not humans or IP addresses.

SQLite deduplicates across tabs, devices, and restarts using HMAC identity hashes
with an independently random key for each UTC day. Old hashes and keys are
removed on the first activity of the next day, at startup, or by the 30-second
cleanup sweep; only aggregate totals are retained indefinitely. No message
contents, IPs, or third-party analytics are collected for this metric.

## Push notifications

Push alerts are content-free wake-ups. Enabling is always an explicit click, and
each identity decides per browser. An alert goes out once, when a message is
accepted and the recipient has no attentive browser open. It can wait at the push
service until the message's unopened retention limit runs out, 24 hours after
acceptance.

The browser's push subscription is the source of truth and the server stores a
copy keyed by endpoint. Whenever an identity starts, the browser keeps its
subscription only if that identity opted in there: it uploads an opted-in
subscription again, and removes one left over from another identity or made with
a rotated VAPID key. The endpoints are `POST /api/push/{subscribe,unsubscribe}`,
authenticated with the identity's session.

Deliberate limits, kept to keep the code small:

- No retry. A failed or timed-out wake-up is dropped; the next message tries again.
- An endpoint belongs to the identity that uploaded it last.
- Each identity keeps its five most recent subscriptions; older ones are dropped.
- A push service rejection (401/403/404/410) deletes the endpoint. If an endpoint
  dies without the browser noticing, turn notifications off and on again.
- Tabs do not coordinate. Toggling in two tabs at once can disagree until the
  next load, which repairs it.

---
