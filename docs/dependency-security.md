# Dependency security review — 2026-10-21

This focused patch batch implements the Chat section of the shared dependency
upgrade plan. Registry metadata and fresh Bun audits were checked on this date;
these are verified versions, not an assumption that `latest` is compatible.

## Applied updates

| Package | Before | After | Reason |
| --- | --- | --- | --- |
| concurrently | 10.0.4 | 10.0.6 | Parent release pins shell-quote 1.12.0, clearing [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) without an override. |
| Top-level Vite | 8.2.1 | 8.2.4 | Patched release for the three launch-editor advisories listed below; keeps the existing supported 8.2 branch. |
| source-map-js | 1.2.1 and 1.2.2 | 1.2.2 throughout | Clears [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) within existing dependency ranges. |

The Vite update also resolves PostCSS to 8.5.29 and nanoid to 3.3.20. Both were
already present in nested lockfile entries; the refresh deduplicates those
entries along with source-map-js. Production dependency versions are unchanged.

Verification sources: [concurrently 10.0.6 release](https://github.com/open-cli-tools/concurrently/releases/tag/v10.0.6),
[Vite 8.2.4 release](https://github.com/vitejs/vite/releases/tag/v8.2.4),
[Vite support policy](https://vite.dev/releases), and live registry metadata
queried with `bun pm view`.

## Remaining advisories

`bun audit --json` now reports **nine advisories: two high, six moderate and one low**.
The verification rerun found two additional Vite advisories beyond the seven
recorded initially; dependency versions have not changed.
All are in the development dependency chain below. The top-level Vite 8.2.4,
shell-quote 1.12.0 and source-map-js 1.2.2 have no findings in this audit.
`bun audit --production --json` returns `{}` (exit 0).

```text
0xchat (devDependencies)
└── vitepress 1.6.4
    └── vite 5.4.21
        └── esbuild 0.21.5
```

| Advisory | Severity reported by Bun | Dependency path | Exposure |
| --- | --- | --- | --- |
| [GHSA-v6wh-96g9-6wx3](https://github.com/vitejs/launch-editor/security/advisories/GHSA-v6wh-96g9-6wx3) | Moderate | vitepress → vite | Windows editor middleware can disclose NTLM credentials through a UNC path. |
| [GHSA-4w7w-66w2-5vf9](https://github.com/vitejs/vite/security/advisories/GHSA-4w7w-66w2-5vf9) | Moderate | vitepress → vite | Development server can expose source-map files outside the allowed directory. |
| [GHSA-fx2h-pf6j-xcff](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff) | High | vitepress → vite | Windows alternate paths can bypass development-server file denials when the server is exposed to the network. |
| [GHSA-698v-4r3x-3vcv](https://github.com/vitejs/launch-editor/security/advisories/GHSA-698v-4r3x-3vcv) | Moderate | vitepress → vite | Windows command escaping can permit editor command injection with attacker-controlled filenames/environment or alternate streams. |
| [GHSA-r825-w8mm-5pxw](https://github.com/vitejs/launch-editor/security/advisories/GHSA-r825-w8mm-5pxw) | Moderate | vitepress → vite | Editor flag interpretation can execute commands; upstream's Vite scenario requires WSL, a susceptible editor and an attacker-created filesystem entry. |
| [GHSA-587h-7wmj-h5pm](https://github.com/vitejs/launch-editor/security/advisories/GHSA-587h-7wmj-h5pm) | High | vitepress → vite | Windows path handling bypasses the editor file-existence check, enabling command injection in combination with the escaping issue. |
| [GHSA-9jrq-w75r-8gcw](https://github.com/vitejs/vite/security/advisories/GHSA-9jrq-w75r-8gcw) | Low | vitepress → vite | Cross-origin script execution requires a custom HTML middleware setup that passes the unchanged request URL to `transformIndexHtml`, inline module scripts, and sensitive state/actions. This repository adds no such custom middleware; the vulnerable nested dependency remains reported. |
| [GHSA-rq7h-c2jc-7f22](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22) | Moderate | vitepress → vite | On non-Windows hosts, an imported project path matching a readable absolute host path can bypass `server.fs.allow`. Upstream lists network exposure as an impact condition; its PoC also uses loopback, so do not treat localhost binding as a complete security boundary. |
| [GHSA-67mh-4wv8-2f99](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99) | Moderate | vitepress → vite → esbuild | A malicious website can read an esbuild development server's responses. This applies to esbuild's serve API; this repository does not start that server. |

Chosen mitigation is to serve the generated `dist/docs/` through the Bun app
server in production, and keep documentation development on localhost with
trusted input. No Vite/VitePress development server should be exposed publicly.
Loopback binding reduces remote exposure but does not by itself prevent a
malicious website from reaching vulnerable local middleware. Avoid untrusted
browsing while running the old docs development server, particularly on Windows
or WSL. These development-server issues are not exercised by serving the built
static docs through `bun run start`. Prefer the built docs when previewing
untrusted changes; do not rely on `server.fs.allow` alone to protect host files.
The two newly recorded findings stay in the same deferred docs-toolchain batch:
no forced nested-major upgrade or audit suppression is introduced here.

Deferral is deliberate: registry tags still identify VitePress 1.6.4 as `latest`
and 2.0.0-alpha.20 as `next`. Version 1.6.4 requires Vite `^5.4.14`, outside
[Vite's supported branches](https://vite.dev/releases). The patched 6.4+ releases
and esbuild 0.25.0+ are outside their parents' declared ranges. A bounded docs
override or docs-toolchain migration needs a separate compatibility change;
forcing nested Vite to 8 would also violate the Vue plugin's supported range.
No audit suppression or dependency override was added. Revisit these findings
with that docs change, including production build, search/navigation, assets,
and strict CSP/no-inline-script checks.

## Validation

Validation used Bun 1.4.3 in an isolated copy of tracked sources, preserving the
checkout's existing database, `.env`, build output and installed dependencies.

- `bun install --frozen-lockfile`: passes with the updated manifest and lockfile.
- `bun run typecheck`: passes for client, server and CLI.
- `bun run lint`: passes.
- `bun run test`: passes, **529 tests across 51 files**, including app/docs
  production builds, docs no-inline-script/handler checks and CSP header checks.
  The sandboxed attempt could not run localhost-dependent tests; the complete
  run passed with localhost networking available.
- Full and production-only audits rerun against the unchanged lockfile: nine
  documented VitePress-chain findings; production audit returns `{}` (exit 0).
  The full audit intentionally remains nonzero. Both additional findings were
  assessed against the upstream advisories linked above.
- `bun run dev`: concurrently starts the API and Vite 8.2.4; browser identity
  registration, live connection through the API proxy, invalid-address
  validation and settings all work. Both child processes stop on SIGINT.
- Built app via `PORT=33087 bun run start`: browser identity connects; Help opens
  built docs; docs navigation, local search, search-result anchors, history,
  direct reload and return to `/chat` work. No browser warning/error logs were
  recorded in these checks, including no CSP violations.

No merge or deployment was performed.
