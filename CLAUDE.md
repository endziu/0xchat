# CLAUDE.md

Commands, source layout, architecture, crypto scheme, and the API table are in the README:

@README.md

## Environment

You are on a WSL on Windows.

- In all interactions and commit messages, be extremely concise and sacrifice grammar for the sake
  of concision.

## Working here

- Bun only — never `node` / `npm` / `npx`.
- `bun run typecheck` and `bun run lint` before calling anything done. `bun run test` clears the db
  and builds first, so it is slow but is the real check.
- Three tsconfigs: `tsconfig.client.json`, `tsconfig.server.json`, `tsconfig.json`. Client code is
  Preact, not React.
- Bump `package.json` version with every change. The UI reads its version from there.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `endziu/0xchat`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default triage label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.
