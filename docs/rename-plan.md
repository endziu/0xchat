# 0xChat → hushhash: rename plan

Date: 2026-10-24.

0xChat becomes **hushhash** at `https://hushhash.org`, starting with an empty
database. There are only a handful of users, and they can be messaged directly,
so there is no recovery page, migration code, or long overlap window. Users copy
their private key from the old app and import it into the new one; their address
stays the same.

Nothing is migrated: messages, registrations, sessions, push subscriptions,
contacts, labels, and preferences all start fresh.

## 0. For the implementing agent

Paths: app `/home/endziu/Projects/dev/droplet/apps/0xChat`, deployment
`/home/endziu/Projects/dev/droplet/remote`, homepage
`/home/endziu/Projects/dev/droplet/apps/homepage`. Line numbers are as of
2026-10-24; locate by `rg` if they've drifted.

**Agent does** (on a `hushhash-rename` branch in each repo, one PR each, never
merging or deploying without the owner's go-ahead):

- §2 app changes, committing this plan with them, plus homepage text and link
  changes from §4.
- §3 `remote` changes.
- Running every "Done when" check and reporting failures verbatim.
- The skill rename and identity copy (§4), when asked.

**Owner does, or explicitly delegates per step:** GitHub repo rename, DNS,
`./ctl deploy` / `./ctl ssl` (needs the vault password), messaging users, choosing
`<DATE>`, and the droplet teardown in §5 step 7. Run the `mv apps/0xChat
apps/hushhash` from outside any session working in that directory, then
re-point T3 to the new path; moving a session's own working directory breaks it.

Never read real private keys, `.env`, or `remote/ansible/secrets.yml`; use
throwaway identities for tests. Don't send anything with the messaging skill as a
test.

## 1. Naming

| Surface | Current | Target |
| --- | --- | --- |
| Product / package | `0xChat` / `0xchat` | `hushhash` |
| GitHub repository | `endziu/0xchat` | `endziu/hushhash` (rename in place) |
| Origin | `https://chat.endziu.xyz` | `https://hushhash.org` (apex only, no `www`) |
| Local checkout | `apps/0xChat` | `apps/hushhash` |
| Ansible app / service / dir | `0xChat`, `0xChat.service`, `/opt/apps/0xChat` | `hushhash`, `hushhash.service`, `/opt/apps/hushhash` |
| Backend port | `3002` | `3003` (new; lets both run during testing) |
| CLI env vars | `OXCHAT_SERVER`, `OXCHAT_IDENTITY` | `HUSHHASH_SERVER`, `HUSHHASH_IDENTITY` |
| CLI default identity | `~/.config/0xchat/identity.json` | `~/.config/hushhash/identity.json` |
| Capability header | `X-0xChat-Delivery-Capability` | `X-Hushhash-Delivery-Capability` |

Unchanged: `/chat`, `/chat/<address>`, `/docs/`, API routes, `chat.db`, the
`chat` backup alias, key derivation and address calculation, icons, and the
VAPID key pair. Push subscriptions are tied to the origin, so they start fresh
regardless of the key.

## 2. Application changes (this repo)

One PR. Bump `package.json` to `0.6.0`. The repo has no changelog or tags, so
the PR description serves as release notes.

**Branding.** `package.json` (+ `bun.lock` root name), `index.html`,
`public/manifest.webmanifest`, notification titles, UI strings, CLI help
(`src/cli/main.ts:14`) and errors (`main.ts:351`), the 426 message
(`src/server/http.ts:59`), `README.md` (including clone URL and CLI
examples), `GLOSSARY.md`, `docs/cli.md`, `site/` (VitePress config, theme,
content), `.github/`, `CLAUDE.md` and `docs/agents/issue-tracker.md` (repo name), and
`.claude/skills/run-0xchat` → `run-hushhash`.

**Protocol strings.** Rename these to `hushhash …`, keeping their version
suffixes. This is cleanup rather than a security boundary: challenges already
bind `Origin:`, and the database is empty anyway.

- `src/shared/crypto.ts:28`: HKDF info `0xChat AES-GCM v2`
- `src/shared/message-envelope.ts:33/80/91`: header, AAD, signed envelope
- `src/shared/registration-challenge.ts:10` and `session-challenge.ts:8`

Old clients then get the existing 426 `client_update_required` response
(missing header) or a signature failure. No dual acceptance and no new
fixtures; just update the tests that hardcode these strings.

**CLI.** `src/cli/client.ts:65`: `prod` → `https://hushhash.org`;
`main.ts:259-260`: new env vars and default path. No fallback to the old names.

**Browser storage and service worker.** Rename the `0xchat_*` / `0xchat.push.*`
keys to `hushhash_*` (including `public/theme.js`). Delete
`src/client/lib/storage-migration.ts`, its four `migrateKey` call sites, and the
`eth_chat_*` constants and tests: the new origin has nothing to migrate.
`public/sw.js`: rename the cache names and the notification tag.

**Done when:** `bun run typecheck`, `bun run lint`, and `bun run test` (it wipes
the local `chat.db*`) pass, and
`rg -i '0xchat|oxchat|eth_chat|chat\.endziu'` shows only intentional matches
(this plan, historical docs).

## 3. Deployment changes (`../../remote`)

One commit, merged at step 4 of §5.

| File | Change |
| --- | --- |
| `ansible/playbook.yml` | Turn the existing placeholder `hushhash` entry (`type: static`, source `apps/hushhash-landing`) into the server app: copy the 0xChat entry's fields with `name: hushhash`, `domain: hushhash.org`, `port: 3003`, `description: "hushhash"`, `source: …/apps/hushhash`. Remove the 0xChat entry outright: the old service keeps running on the server until it is torn down by hand (§5 step 7), and nothing can rebuild it from the moved checkout. |
| `ansible/roles/deploy_apps/templates/0xChat.env.j2` | `git mv` → `hushhash.env.j2` (same VAPID vars; check that `VAPID_SUBJECT` is still a valid contact) |
| `ansible/roles/deploy_apps/tasks/main.yml:57-65` | Task name, `src:`, and the `selectattr('name', 'equalto', 'hushhash')` selector |
| `lib/dbs.json` | Key `0xChat` → `hushhash` (keep alias `chat`, db `chat.db`, tables) |
| `ctl:476-477, 542` | DAU working dir `/opt/apps/hushhash`, help text |
| `tests/test_ctl.py:68, 181` | App name and domain list |
| `tests/check_chat_docs.sh:5, 29` | Default origin `https://hushhash.org`, docs title |
| `docs/CTL.md:77-215` | Examples and descriptions |

Leave `ansible/roles/prepare_droplet/tasks/main.yml:250` (`clear game and 0xChat
logs`) unchanged: it is the name of a cron job being removed and must match the
old one.

**Done when:** the repo's Python tests, ShellCheck, Ruff, and
`ansible-playbook --syntax-check` pass.

## 4. Other places

- **GitHub:** rename `endziu/0xchat` → `endziu/hushhash`, update the description
  and homepage URL, then
  `git remote set-url origin git@github.com:endziu/hushhash.git`.
- **Local checkout:** `mv apps/0xChat apps/hushhash`, then fix the T3 project
  path and any open threads pointing at the old path.
- **Homepage** (`../homepage/index.html:52-55`): link, name, and
  `imgs/0xchat.jpg`.
- **Messaging skill:** the real directory is `~/.agents/skills/0xchat`;
  `~/.claude/skills/0xchat` and `~/.codex/skills/0xchat` are symlinks to it.
  Rename the directory to `hushhash`, recreate both symlinks, and update its
  app path, env vars, `--server prod`, and identity path. My own CLI identity:
  `install -Dm600 ~/.config/0xchat/identity.json ~/.config/hushhash/identity.json`.
- **DNS:** done 2026-10-24: apex A record points to `159.89.8.178`, `www` is
  removed. A static placeholder (`apps/hushhash-landing`) is served from the
  `hushhash` playbook entry, which also obtains the `hushhash.org` certificate.
- **Placeholder cleanup:** after the server deploy, delete the leftover
  placeholder `index.html` from `/opt/apps/hushhash` and retire
  `apps/hushhash-landing`.

## 5. Sequence

1. **Build.** Land the app PR (§2) and prepare the `remote` commit (§3). Don't
   deploy yet.
2. **Back up the old state.** `./ctl backup` with the *current* `remote` config,
   so `0xChat/chat.db` is captured. It is only for rollback, never used as seed
   data.
3. **DNS and certificate.** Already done by the placeholder deploy; confirm
   `https://hushhash.org` serves the placeholder.
4. **Rename.** Rename the GitHub repo and local dir, then merge the `remote`
   commit.
5. **Deploy alongside the old service.** Run `./ctl deploy hushhash`. The
   nginx file is replaced in place and the existing certificate is reused; run
   `./ctl ssl` only if `hushhash.org` has no certificate yet. Smoke-test with throwaway identities: register,
   import a synthetic key, browser↔browser and browser↔CLI messages, SSE
   reconnect, push notification and click, PWA install,
   `tests/check_chat_docs.sh`, `./ctl status`, `./ctl doctor`, `./ctl backup`.
6. **Tell users** (template below). Give them a few days on the old app to copy
   their key.
7. **Tear down the old service** after the cutover date, on the droplet:
   ```sh
   cp -a /opt/apps/0xChat/chat.db* ~/0xchat-final/   # or pull a fresh ./ctl backup first
   sudo systemctl disable --now 0xChat
   sudo rm /etc/systemd/system/0xChat.service && sudo systemctl daemon-reload
   sudo rm /etc/nginx/sites-enabled/0xChat.conf /etc/nginx/sites-available/0xChat.conf
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot delete --cert-name chat.endziu.xyz
   sudo rm -rf /opt/apps/0xChat
   ```
   Then remove the `chat.endziu.xyz` DNS record. Until it is gone, requests to
   the old domain hit the catch-all vhost and are refused, which is fine since
   everyone has been told. Delete `~/0xchat-final` once you're sure you won't
   roll back.
8. **Update the homepage** and redeploy it: `./ctl deploy homepage`.

## 6. Message to users

> 0xChat is moving to **https://hushhash.org** on <DATE>. Old messages won't
> carry over.
>
> To keep your address: in 0xChat open Settings → **Copy private key** and save
> it somewhere safe (a password manager). On hushhash.org open Settings →
> **Import private key** and paste it.
>
> You'll need to re-add contacts, turn notifications back on, and reinstall the
> app if you had it installed. A contact's address link only works once they
> have joined hushhash too.

CLI users: set `HUSHHASH_IDENTITY` to the old file, or copy it to
`~/.config/hushhash/identity.json` with mode 600.

## 7. Rollback

- **Before step 7:** the old service is untouched. Stop pointing people at
  hushhash and fix it.
- **After step 7:** restore the old service from the step 2 / step 7 backup only
  if something is badly wrong. Treat it as a separate service: never run 0xChat
  code against hushhash's `chat.db`, and never restore an old backup over it.
