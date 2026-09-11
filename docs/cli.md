# Terminal client

The Bun CLI connects to the existing 0xChat API. It shares the browser's identity,
encryption, signed envelope, and verification code. No server changes or new
dependencies are required.

## Quick start

Select production with `--server prod` (`https://chat.endziu.xyz`):

```sh
bun run cli --server prod init
bun run cli address
bun run cli --server prod chat 0xYOUR_CONVERSATION_PARTNERS_ADDRESS
```

For local development, run `bun run dev` in another terminal, then use
`--server local` (`http://localhost:3000`, also the default):

```sh
bun run cli --server local register
bun run cli --server local chat 0xYOUR_CONVERSATION_PARTNERS_ADDRESS
```

Use `init` instead of `register` if you have not created an identity yet. Each
server has its own registrations and conversations. These examples reuse the
same identity; use `--identity FILE` for a separate development identity.

To select a server for the shell session, run `export OXCHAT_SERVER=prod` or
`export OXCHAT_SERVER=local`. An explicit `--server` overrides this setting.
Custom origins also work, for example `--server http://localhost:4000` or
`--server https://your-chat.example`. The CLI connects to the Bun API port, not
the Vite frontend port.

If `init` reports a connection failure after saving the identity, keep that file
and retry registration after selecting or starting the server:

```sh
bun run cli --server prod register
# Or, after starting bun run dev:
bun run cli --server local register
```

Do not rerun `init`: the identity already exists and will not be overwritten.
If you originally supplied `--identity FILE`, supply it again when registering.

The partner must register on the same server, using either the browser or CLI.
Inside chat, Enter sends, `/ttl 60` changes the lifetime of subsequent messages,
`/help` shows commands, and `/quit` or Ctrl-C exits. Long messages wrap to the
terminal width. Chat shows recent messages that fit the terminal; use `read --all`
to retrieve the rest.

Chat uses the terminal's alternate screen, removes expired messages from its
display, and restores the previous screen on exit. Message input history is not
saved. Incoming control sequences are escaped before rendering.

## Two identities on one machine

Choose a separate identity file for each terminal:

```sh
bun run cli --identity /tmp/alice-0xchat.json init
bun run cli --identity /tmp/bob-0xchat.json init

# Copy the addresses printed above into the two commands:
bun run cli --identity /tmp/alice-0xchat.json chat 0xBOBS_ADDRESS
bun run cli --identity /tmp/bob-0xchat.json chat 0xALICES_ADDRESS
```

Use persistent paths for identities you want to keep.

## Scripts

```sh
bun run cli conversations --json
bun run cli send 0xPARTNER_ADDRESS 'hello from the terminal' --ttl 300
printf '%s' 'text from stdin' | bun run cli send 0xPARTNER_ADDRESS --json
bun run cli read 0xPARTNER_ADDRESS --json
bun run cli read 0xPARTNER_ADDRESS --all --json
bun run cli watch 0xPARTNER_ADDRESS --json
```

`read` returns the latest 100 messages in chronological order. JSON output includes
`messages`, `next_before`, and `next_before_rowid`. Pass both non-null cursors as
`--before` and `--before-rowid` to retrieve the next older page. `--all` fetches
all available pages in chronological order. `watch` first outputs available
history, then emits one JSON object per new message. Diagnostics go to stderr.
Use `--` before message text that starts with a dash.

`watch` and `chat` use SSE, reconnect with bounded exponential backoff, and fetch
history after reconnecting to recover messages still available on the server.
Messages are deduplicated by ID. Sessions are kept in memory, renewed after an
authentication failure, and revoked on normal exit. A killed process's session
expires according to the server's existing policy. Failed sends are not
automatically retried after network errors; delivery may have succeeded, so check
history before resending.

## Identity storage and browser interoperability

The default file is `$XDG_CONFIG_HOME/0xchat/identity.json`, falling back to
`~/.config/0xchat/identity.json`. Override it with `--identity FILE` or
`OXCHAT_IDENTITY`. `OXCHAT_SERVER` accepts `prod`, `local`, or an explicit origin
and selects the default server; flags take precedence.

`init` creates a fresh identity. `import` accepts the browser's exported raw hex
private key, with or without a `0x` prefix:

```sh
bun run cli --identity ./imported-identity.json import --key-file /path/to/exported-key.txt
# A password manager can also pipe a key to: import --key-file -
bun run cli export
```

`export` prints the raw private key, which the browser can import. `address` and
`export` work offline. Use a dedicated burner identity. Identity files contain
unencrypted private keys, are created exclusively with mode `600`, and are never
overwritten by init/import. Back up the file to retain the identity. Symlinks and
files accessible by other users are refused when loading. If initial registration
fails, the saved key remains usable: run `register` after correcting the server
or connection. No plaintext message cache or session token is written to disk.

HTTPS is required for remote servers; HTTP is supported for loopback development.
The server must be specified as an origin, without a path, credentials, query, or
fragment. Redirects are refused. Registration and login challenges are verified
against that origin before signing. Recipient public keys must match their
addresses; incoming messages must have valid signatures and name both selected
conversation participants before decryption.

## Current scope

Text messaging, identity import/export, conversation listing, history, and live
chat are supported. Image messages from the browser appear as an attachment
placeholder in human-readable output; JSON contains their decrypted data URL.
Image upload, push notifications, local conversation labels, and identity deletion
are not implemented in the CLI.

Legacy messages keep the lifetime that started when the server accepted them.
For recipient-opening messages, the server starts the signed lifetime at the
first authenticated opening. Both policies are described in
[domain behavior](domain-behavior.md), and the CLI follows server timestamps.
`read`/`watch` output, shell history, redirected JSON, screenshots, and terminal
recordings can retain plaintext beyond expiry; expiry cannot erase those copies.
Even chat mode cannot prevent terminal capture. A reconnect can recover only
messages that have not expired.

## Verification

```sh
bun run typecheck
bun run lint
bun test src/cli/cli.test.ts src/cli/read.test.ts
```

The CLI tests use isolated servers and temporary or in-memory databases. They
cover browser crypto interoperability, live events, page opening, pagination,
expiry, identity file permissions, and command-line JSON/stdin behavior.
The repository-wide `bun run test` still deletes the database in its working
directory; run it only in a disposable copy if you have data to preserve.

### Message opening and expiry

`read` verifies signed envelopes and authenticates decryption before requesting
message opening from the server. Both legacy and recipient-opening incoming
deliveries require opening confirmation. Sender copies use the read-only lifecycle
lookup for availability confirmation; they and `conversations` never open messages.
A normal read opens only its returned page; cursor reads open that page, and
`--all` opens each history page as it loads it.

Only messages with valid, available confirmations reach output. Missing,
unavailable, duplicate or invalid confirmations suppress the affected messages.
An opening or availability request failure fails the read without printing its
plaintext or the server's error body. Retry
`read` after a lost response: the server preserves the first opening deadline;
retrying cannot restart the lifetime or revive an expired message. The CLI uses
the server time from the confirmation plus elapsed monotonic time, then checks
expiry again before text or JSON output, including after collecting `--all`.

JSON message objects also include `ttl`, `delivery_policy`, and `opened_at`, along
with `created_at` and the confirmed `expires_at`. Text output retains terminal
sanitization; JSON retains the original plaintext for scripts. Already printed
output cannot be recalled from terminal logs or downstream scripts.

The client library's `decode` only verifies and decrypts a delivery; its output is
not an opening confirmation. The `read` command and its explicit `--all` history
perform message opening. Live watch/chat opening and lifecycle updates remain
tracked by #79.
