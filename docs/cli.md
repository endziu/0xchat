# Terminal client

The Bun CLI connects to the existing 0xChat API. It shares the browser's identity,
encryption, signed envelope, and verification code. No server changes or new
dependencies are required.

## Quick start

Run the existing server (`bun run start:prod`) or select a deployed instance with
`--server https://your-chat.example`. The default is `http://localhost:3000`.

```sh
bun run cli init
bun run cli address
bun run cli chat 0xYOUR_CONVERSATION_PARTNERS_ADDRESS
```

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
`OXCHAT_IDENTITY`. `OXCHAT_SERVER` selects the default server; flags take precedence.

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

The current server starts message lifetime at acceptance, as described in
[domain behavior](domain-behavior.md). The CLI follows server timestamps.
`read`/`watch` output, shell history, redirected JSON, screenshots, and terminal
recordings can retain plaintext beyond expiry; expiry cannot erase those copies.
Even chat mode cannot prevent terminal capture. A reconnect can recover only
messages that have not expired.

## Verification

```sh
bun run typecheck
bun run lint
bun test src/cli/cli.test.ts
```

The CLI tests start an unchanged server with a temporary working directory and
database. They cover browser crypto interoperability, live events, pagination,
expiry, identity file permissions, and command-line JSON/stdin behavior.
The repository-wide `bun run test` still deletes the database in its working
directory; run it only in a disposable copy if you have data to preserve.
