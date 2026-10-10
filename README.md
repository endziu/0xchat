# 0xChat

0xChat is a chat app with end-to-end encryption and messages that disappear. Your browser encrypts messages before sending them, so the server cannot read their contents. There is no signup, and you don't need an email address or phone number.

Open the app and it creates an account for you. Share your **address** (a string of letters and numbers starting with `0x`), conversation link or QR code so people can message you. Choose how long each message stays after the other person opens it, from 5 seconds to 24 hours.

> **Keep access to your account:** the app saves a secret code called a **private key** in your browser. Back it up and keep it secret. If you lose every copy, you lose access to the account permanently. Creating a new address is quick and free, so you can also use a throw-away account without backing it up. Use the key 0xChat creates for you; never import a key from a crypto wallet that holds money or anything else of value.

## What 0xChat does

- Creates an account automatically, with no password to remember.
- Lets people contact you through your address, conversation link or QR code.
- Encrypts messages and checks which address sent them.
- Delivers messages live, with optional notifications that keep message contents private.
- Deletes messages when their timer runs out, or 24 hours after sending if they are never opened.
- Lets either person clear a conversation's messages for both of them immediately.
- Works in your browser and can be installed on your phone or computer.
- Lets you back up your key, use your account on another device or delete your account.

0xChat uses the same kind of addresses as Ethereum, but you don't need cryptocurrency or a wallet to chat. There are no transaction fees, and chats are not published to a blockchain. You do need an internet connection.

See [Getting started](site/getting-started.md) for a walkthrough, or [Your key and account](site/your-key.md) to learn how to back up your key.

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

## User docs

End-user documentation lives in `site/` as Markdown, is built with VitePress into
`dist/docs/`, and is served by the app at `/docs/` (linked from Settings). Preview it
with `bun run docs:dev`. The docs share the app's origin and strict CSP, so they must not
emit inline scripts; a server test checks the built pages.

## Build and run

Build the frontend and docs into `dist/`:

```sh
bun run build
```

Run the server against an already-built `dist/`:

```sh
bun run start
```

Add `DEBUG=1` for verbose logs. For a clean local demonstration, run
`bun run clear:db` and `bun run build` first.

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
bun run build        # build frontend SPA and user docs into dist/
bun run docs:dev     # preview the user docs (site/) with live reload
bun run icons        # regenerate public icons and favicon
bun run stats:dau    # read historical daily active identity totals from local chat.db (JSON)
bun run start        # start server using an existing dist/
bun run clear:db     # delete chat.db and WAL/SHM files only
bun run clear:dist   # delete dist/ only
bun run clear:all    # delete database files and dist/
bun run typecheck    # TypeScript checks without emitting files
bun run lint         # lint src and server.ts
bun run test         # clear all, build, then run Bun tests
```

Runtime data is stored in `chat.db` beside the project. The database, build output, dependencies, and `.env` are ignored by Git.

## Rate limits

All limits below are per minute. Each operation has its own budget, so one never
consumes another's.

| Operation | Per identity | Per IP |
|---|---:|---:|
| Send message | 120 (per IP + identity) | 240 |
| Open messages | 120 (across devices and networks) | 240 |
| Recover messages (initial and continuation pages) | 120 | 240 |
| Lifecycle state lookup | 120 | 240 |
| Clear conversation | 10 | 20 |
| Attention update | 60 (per IP + identity) | — |
| Registration removal | — | 10 |
| Push subscribe/unsubscribe | 10 (per IP + identity) | — |
| Registration challenge, registration, auth challenge, auth session, SSE token | — | 10 each |

The per-IP message cap gives two identities that share an IP their full individual
allowance while still putting a ceiling on identity cycling. Opening and state
lookup take 1–100 distinct IDs per request with an 8 KiB body limit. Every
request body is capped at 32 KiB; larger bodies get `413`. See
[the message lifecycle API](docs/message-lifecycle-api.md).

Live event streams are capped by count rather than per minute: at most 3 open
at once per identity and 20 per IP. A stream past either cap gets `429`.

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
