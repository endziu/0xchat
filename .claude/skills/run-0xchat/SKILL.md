---
name: run-0xchat
description: Build, run, and drive 0xChat in headless Chromium. Use when asked to start or run the app, take a screenshot of its UI at desktop or phone width, check a UI change in the real app, or send messages between a browser identity and the CLI.
---

Build the SPA, start the Bun server on port 3000, then drive a headless
Chromium with `.claude/skills/run-0xchat/driver.ts`, which reads one command
per line on stdin. The CLI (`bun run cli`) is the easiest second chat party.

All paths are relative to the repo root. Output (screenshots, logs, the CLI
identity, a kept browser profile) goes in `.scratch/run/`, which is gitignored.

## Prerequisites

Bun, and a Chromium on `PATH` as `chromium`. Set `CHROMIUM=/path/to/binary` to
use another one. A fresh clone or worktree also needs `bun install` and a
`.env` copied from `.env.example`.

## Build and start

```bash
bun run build
mkdir -p .scratch/run
(DEBUG=1 bun run start > .scratch/run/server.log 2>&1 &)
timeout 30 bash -c 'until curl -sf http://localhost:3000 >/dev/null; do sleep 0.5; done'
```

`start` serves `dist/`, so run `bun run build` again after client
changes. Stop the server with:

```bash
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill
```

## Run (agent path)

Screenshot the header at phone and desktop width:

```bash
bun .claude/skills/run-0xchat/driver.ts <<'EOF'
size 360
nav /chat
wait-for header [aria-label="Copy address"]
screenshot header-360
size 1024
screenshot header-1024
EOF
```

Each command echoes to stderr. Screenshots print their path and land in
`.scratch/run/<name>.png` at 2x scale. On any failure the driver prints the
error and the page console, saves `.scratch/run/error.png`, and exits 1.

Chat between the browser and the CLI. `PROFILE` keeps the browser identity
across driver runs, and `--identity` keeps the CLI away from your real
`~/.config/0xchat/identity.json`:

```bash
C="bun run cli --identity .scratch/run/cli.json"
$C init
CLI=$($C address 2>/dev/null)
PROFILE=.scratch/run/profile bun .claude/skills/run-0xchat/driver.ts <<EOF
size 360
nav /chat/$CLI
fill textarea hello from the browser
click button[aria-label=Send]
wait-text hello from the browser
EOF
BROWSER=$($C conversations --json 2>/dev/null | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).conversations[0].address)')
$C read $BROWSER
$C send $BROWSER 'hello from the cli'
PROFILE=.scratch/run/profile bun .claude/skills/run-0xchat/driver.ts <<EOF
size 360
nav /chat/$CLI
wait-text hello from the cli
screenshot cli-received
EOF
```

`init` refuses to overwrite an existing identity file. Skip it, or delete
`.scratch/run/cli.json`, on later runs.

| command | what it does |
|---|---|
| `size <w> [h]` | Viewport in CSS px (height defaults to 640). Below 640 it is the phone layout. Starts at 1024x700. |
| `nav <path-or-url>` | Navigate, relative to `BASE` (default `http://localhost:3000`). |
| `wait-for <selector>` | Poll for an element (10 s timeout). |
| `wait-text <text>` | Poll until the page text contains `<text>`. |
| `click <selector>` | Wait for an element, then click it. |
| `fill <selector> <text>` | Set the value and fire `input`, which Preact listens for. |
| `text <selector>` | Print the element's `innerText`. |
| `eval <js>` | Evaluate an expression and print it as JSON (promises are awaited). |
| `screenshot [name]` | Save `.scratch/run/<name>.png`. |
| `focus on\|off` | Emulate a focused or unfocused window. Starts `on`. |
| `sleep <ms>` | Wait. |
| `logs` | Print page console output and exceptions so far. |

Environment variables: `BASE`, `OUT` (screenshot directory), `CHROMIUM`, and
`PROFILE` (a kept profile directory). Without `PROFILE`, each run gets a fresh
temporary profile, which means a new burner identity registered on load.

## Run (human path)

`bun run dev` starts the API on 3000 and Vite with hot reload; open the URL
Vite prints. `bun run cli` against port 3000 works with either server.

## Test

```bash
bun run typecheck
bun run lint
bun run test
```

`bun run test` deletes `chat.db` and `dist/` and rebuilds before running
464 tests across 44 files (about 40 s). Stop the server first, and run
`bun run build` again before restarting it.

## Gotchas

- **`chromium --headless --screenshot` never returns on this app.** The live
  event stream keeps the page loading forever, and `--virtual-time-budget`
  doesn't help. The driver polls for elements instead of waiting for load.
- **Headless pages report `document.hasFocus() === false`.**
  `src/client/lib/window-attention.ts` then treats the window as inattentive,
  so messages, including ones you just sent, never render. The server log still
  shows the `[msg]` line. The driver turns on focus emulation at start; use
  `focus off` only to test unfocused behaviour.
- **Killing Chromium loses the identity in `PROFILE`.** Chromium writes
  `localStorage` to disk in delayed batches, so a short run that is killed
  registers a new identity next time. The driver closes the browser with the
  DevTools `Browser.close` command instead; keep it that way.
- **The browser's full address isn't on screen.** The header shows
  `0x67FC…469d`. Get it from `cli conversations --json` once the browser has
  messaged the CLI, as above.
- **Don't `pkill -f chromium`.** This machine uses Chromium as its desktop
  browser. The driver kills only the instance it launched and deletes its
  temporary profile.
- **`bun run cli` echoes `$ bun run src/cli/main.ts …` on stderr.** Add
  `2>/dev/null` when capturing output with `$(…)`.

## Troubleshooting

- **`Timed out … waiting for text` after a send, while `server.log` shows
  `[msg]`:** the page was unfocused. Check `.scratch/run/error.png`, and
  remove any `focus off` before the send.
