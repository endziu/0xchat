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

## Server

- `server.ts` is boot only: `initDb()`, cleanup timers, `Bun.serve`. Do not add logic there.
- Adding an endpoint = a handler file under `src/server/routes/` + one entry in the `routes` table in
  `src/server/router.ts`. The table is ordered; the catch-all static handler must stay last.
- **Every route must live under `/api/`.** In production Nginx allowlists `/api/*`, static asset
  extensions, `/chat`, `/chat/*`, `/pk`, and exact `/` — everything else gets `444`. A route outside
  `/api/` works locally and is silently unreachable once deployed.
- Shared helpers, not ad-hoc code: `json()` and session extraction from `http.ts`, validators from
  `validation.ts`, `log`/`warn`/`error` from `constants.ts`, `ChallengeStore` from `challenge.ts`.
- Auth-bearing handlers check `getSessionAddress(req)` and return 401 before touching the body.
- Push (`push.ts`, `routes/push.ts`): `sendNotification` is always called with no payload — never
  add one, that would leak sender/recipient/content to the relay (FCM/Mozilla/Apple). Subscription
  `endpoint` host must stay checked against `ALLOWED_PUSH_HOSTS` in `validation.ts` — without it any
  user can point the server at an arbitrary HTTPS URL (SSRF via `webpush.sendNotification`).

## Client

- Private keys never leave `localStorage` and never go over the wire. Plaintext is encrypted
  client-side twice (recipient pubkey + own pubkey) before any request.
- Contact state is local: `eth_chat_known_contacts_v1`, `eth_chat_deleted_contacts_v1`, and
  `last_seen_<address>`. Conversation deletion is local-only — it hides a contact until a newer
  `last_message_at` supersedes it, and deletes nothing server-side.
- Account deletion is the server-side one: `DELETE /api/addresses/:addr`, self only.
- All hex in API and DB uses the `0x` prefix, except stored pubkeys, which are stripped.

## Mobile / PWA

- Tailwind's `hover:` compiles under `@media (hover: hover)`. So **never hide a control with a bare
  `opacity-0` / `invisible` that only a `group-hover:` undoes** — on touch it is invisible forever.
  Gate the hiding half with the `can-hover:` variant defined in `styles.css`.
- `@media (pointer: coarse)` in `styles.css` forces every `button`/`select` to 44×44. Don't fight it
  with tiny `p-0.5`; drop the padding and let the rule size the target.
- Destructive controls that are always visible on touch need a two-tap confirm (see logout in
  `Layout.tsx`, delete in `ConversationList.tsx`).
- `index.html` sets `viewport-fit=cover`; the `safe-top` / `safe-bottom` / `safe-x` utilities are
  applied once on the Layout shell, not per bar. Don't add `env(safe-area-inset-*)` elsewhere.
- Icons are generated, not committed by hand: `bun run icons` rewrites `public/*.png` +
  `favicon.svg` from `scripts/gen-icons.ts`. Edit the script, never the PNGs.
- `public/sw.js` caches the app shell only — it bails on `/api/*` so ciphertexts, tokens and SSE
  never hit the cache. Bump `VERSION` there when its logic changes.
- `static.ts` sets `Cache-Control`: `/assets/*` immutable, `sw.js`/manifest/HTML `no-cache`. A
  cached `sw.js` pins an old build, so leave that alone.

## Deploy

Hybrid: frontend built locally, `dist/` plus source rsync'd to the droplet, Bun server on port 3002
behind Nginx as systemd unit `0xChat`. Deployment lives in a different repo (`remote/`) — changes
there are a separate commit. Never deploy unless asked.

Push notifications need `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` in the droplet's env
for the systemd unit — soft-disabled (503 on the vapid-key route) without them, not a boot failure.
