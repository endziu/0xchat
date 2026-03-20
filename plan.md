# Plan: Preact SPA + Burner Wallet Migration

## Context

ETH-Chat currently requires MetaMask (or any injected wallet) for both identity and signing. This creates friction — users must have a wallet extension installed, connect it, and sign messages. The goal is to replace this with auto-generated burner keypairs stored in localStorage, so any user can visit a link and immediately start chatting with zero setup. The frontend is also being modernized from vanilla JS + HTML templates to a Preact SPA with Tailwind CSS v4.

## What Changes vs. What Stays

**Stays unchanged:** All `src/server/` modules (db.ts, sse.ts, rate-limit.ts, verify.ts), all API routes in server.ts, the ECIES crypto scheme, the SSE event format.

**Changes:**
- Key derivation: `MetaMask.sign → SHA-256 → seed` → `crypto.getRandomValues(32) → privkey`
- Signing: MetaMask `personal_sign` → `@noble/secp256k1` + keccak256 (EIP-191 compatible, server verify.ts unchanged)
- Frontend: vanilla JS + HTML templates → Preact SPA built with Vite
- Styles: custom CSS → Tailwind v4
- Wallet deps: entire AppKit/wagmi/MetaMask SDK stack → removed

---

## New File Tree

```
eth-chat/
├── package.json                 MODIFY
├── tsconfig.json                MODIFY (base, no types/lib)
├── tsconfig.server.json         CREATE
├── tsconfig.client.json         CREATE
├── vite.config.ts               CREATE
├── server.ts                    MODIFY (remove HTML/JS serving, serve dist/)
├── server.test.ts               MODIFY (update readiness probe, remove /register tests)
│
├── src/client/                  CREATE ALL
│   ├── index.html
│   ├── main.tsx
│   ├── styles.css
│   ├── lib/
│   │   ├── burner.ts            key gen, storage, EIP-191 signing, address derivation
│   │   ├── crypto.ts            ECIES encrypt/decrypt (port of chat-crypto.js)
│   │   ├── api.ts               typed API client
│   │   └── session.ts           bearer token management
│   ├── hooks/
│   │   ├── useIdentity.ts       key lifecycle: generate, load, register, delete
│   │   ├── useSession.ts        auth token: acquire, refresh, clear
│   │   ├── useConversations.ts  load + refresh conversation list
│   │   ├── useMessages.ts       load + decrypt + send messages
│   │   └── useSSE.ts            EventSource lifecycle + dispatch
│   └── components/
│       ├── App.tsx              router root (pathname-based, no router lib)
│       ├── Layout.tsx           outer shell
│       ├── OnboardingView.tsx   first-visit (auto-generates key silently)
│       ├── KeyManagement.tsx    export hex/QR, import, delete identity
│       ├── Sidebar.tsx          conversation list + identity strip
│       ├── ConvItem.tsx         single conversation row
│       ├── ChatPane.tsx         message thread + input
│       ├── MessageBubble.tsx    single message + expiry timer
│       ├── MessageInput.tsx     textarea + TTL select + send
│       └── StatusBar.tsx        transient error/info toasts
│
├── src/server/                  KEEP (db, sse, rate-limit, verify unchanged)
│   ├── chat-crypto.js           DELETE
│   ├── chat-session.js          DELETE
│   ├── chat-client.js           DELETE
│   ├── utils.js                 DELETE
│   ├── secp256k1.bundle.js      DELETE (generated)
│   ├── wallet.bundle.js         DELETE (generated)
│   └── views/                   DELETE entire directory
│
├── src/crypto-entry.ts          DELETE
└── src/wallet-entry.ts          DELETE
```

---

## Dependencies

**Remove from package.json:**
- `@coinbase/wallet-sdk`, `@metamask/sdk`, `@reown/appkit`, `@reown/appkit-adapter-wagmi`, `@wagmi/core`, `@walletconnect/ethereum-provider`, `porto`

**Add:**
- `@noble/hashes` — keccak256 for address derivation + EIP-191 signing
- `preact` — UI framework (~3KB)
- `@preact/preset-vite` (devDep) — Vite plugin
- `tailwindcss` (devDep) — v4, CSS-first
- `vite` (devDep) — build + dev server

Keep: `@noble/secp256k1` (v3, already present), `viem` (server-side verify.ts), `bun:sqlite`

---

## vite.config.ts

```ts
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [preact()],
  root: 'src/client',
  build: { outDir: '../../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
```

---

## server.ts Changes

Remove:
- `WALLETCONNECT_PROJECT_ID` env guard
- All `readFileSync` calls for HTML and JS files
- `injectTemplate` / `htmlResponse` helpers
- `JS_FILES` map and static JS serving block
- `/register` GET route and `/chat` HTML routes

Add after all API routes:
```ts
// Static assets from Vite build
if (method === 'GET' && path.startsWith('/assets/')) {
  const file = Bun.file(join(dir, 'dist', path));
  return await file.exists()
    ? new Response(file)
    : json({ error: 'Not found' }, 404);
}

// SPA fallback — all navigation routes
if (method === 'GET') {
  return new Response(Bun.file(join(dir, 'dist/index.html')), {
    headers: { 'Content-Type': 'text/html' },
  });
}
```

---

## lib/burner.ts — Key Spec

**Identity type:**
```ts
interface BurnerIdentity {
  privkey: Uint8Array;  // 32 bytes
  pubkey: Uint8Array;   // 33 bytes compressed
  address: string;      // '0x' + 40 lowercase hex
}
```

**Address derivation:**
```
secp.getPublicKey(privkey, false)  // 65 bytes uncompressed
→ drop first byte (0x04)           // 64 bytes
→ keccak256(64 bytes)              // 32 bytes
→ last 20 bytes → '0x' + hex      // Ethereum address
```

**EIP-191 signing (must match viem's recoverMessageAddress):**
```
prefix = "\x19Ethereum Signed Message:\n" + message.length
hash = keccak256(UTF8(prefix) + UTF8(message))
{ r, s, recovery } = secp.sign(hash, privkey, { lowS: true })
sig = '0x' + r.toHex(32) + s.toHex(32) + (27 + recovery).toString(16).padStart(2, '0')
```

**Exports:** `generateIdentity`, `loadIdentity`, `saveIdentity`, `deleteIdentity`, `signMessage`, `ensureIdentity`

**Storage key:** `eth-chat-privkey` (hex, 64 chars) in `localStorage`

---

## lib/crypto.ts — ECIES Spec

Direct TypeScript port of `src/server/chat-crypto.js`. Parameters identical (no scheme change):
- ECDH: `secp.getSharedSecret(ephemPriv, recipientPub, true)` → 33 bytes
- HKDF-SHA-256: salt=ephemPub (33 bytes), info=`"ETH-Gate AES-GCM v1"`, length=32
- AES-GCM-256: 12-byte random IV
- decrypt takes `privkey: Uint8Array` directly (no SHA-256 step unlike old code)

```ts
encrypt(plaintext: string, recipientPubkeyHex: string): Promise<EncryptResult>
decrypt(ciphertextHex: string, ephemeralPubHex: string, ivHex: string, privkey: Uint8Array): Promise<string>
```

---

## lib/session.ts

- Stores bearer token in `sessionStorage` (wiped on tab close; identity stays in localStorage)
- `authenticate(address, privkey)`: challenge → sign with `burner.signMessage` → POST session
- Re-exports: `loadSession`, `saveSession`, `clearSession`, `authenticate`

---

## lib/api.ts

Typed wrappers for all endpoints. Throws `ApiError(status, body)` on non-2xx. All functions take `token` explicitly where auth is required. No global state.

---

## useIdentity Hook Behavior

On mount:
1. `loadIdentity()` → if found, check `/api/pubkey/:address`
2. If not registered → auto-register: sign `"ETH-Gate keypair v1"` with burner key, POST `/api/register`
3. If no identity → `generateIdentity()` + save + register (silent, zero-friction first visit)

This means visiting `/chat/0xALICE` auto-creates the visitor's identity and opens the chat with Alice immediately.

---

## tsconfig Split

`tsconfig.json` (base): strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, verbatimModuleSyntax, isolatedModules, moduleResolution: "bundler". No lib/types.

`tsconfig.server.json`: extends base, `lib: ["ES2022"]`, `types: ["bun-types"]`, includes server.ts + src/server.

`tsconfig.client.json`: extends base, `lib: ["ES2022","DOM","DOM.Iterable"]`, `jsx: "react-jsx"`, `jsxImportSource: "preact"`, includes src/client.

---

## Tailwind v4 Theme

```css
/* src/client/styles.css */
@import "tailwindcss";

@theme {
  --color-bg: #0a0a0c;
  --color-surface: #111115;
  --color-border: #1e1e26;
  --color-text: #e8e6e1;
  --color-dim: #6b6a72;
  --color-accent: #c4f84a;
  --color-danger: #ff4444;
  --font-mono: 'DM Mono', monospace;
}
```

Custom tokens become Tailwind utilities: `bg-bg`, `text-accent`, `border-border`, etc.

---

## Build Scripts

```json
{
  "dev": "vite",
  "build": "vite build",
  "server": "bun run server.ts",
  "server:dev": "bun --watch server.ts",
  "typecheck": "tsc --noEmit -p tsconfig.server.json && tsc --noEmit -p tsconfig.client.json",
  "lint": "oxlint src/server src/client server.ts",
  "test": "bun test"
}
```

Dev workflow: run `bun run server:dev` and `bun run dev` in two terminals. The Vite dev server (5173) proxies `/api` to Bun (3000).

---

## Migration Order

1. **Scaffold + Vite** — create vite.config.ts, index.html, main.tsx stub, styles.css; update package.json deps; modify server.ts to serve dist/; run build → verify `/chat` serves Preact shell
2. **lib/burner.ts + tests** — key gen, address derivation, EIP-191 signing; verify against real `/api/auth/*` endpoints
3. **lib/crypto.ts + tests** — ECIES port; verify encrypt→decrypt round-trip
4. **lib/api.ts + lib/session.ts** — typed API client + auth flow
5. **Hooks** — useIdentity → useSession → useConversations → useMessages → useSSE
6. **Components** — Layout → OnboardingView → Sidebar → ChatPane → MessageBubble → MessageInput → KeyManagement
7. **Delete old frontend** — remove chat-crypto.js, chat-session.js, chat-client.js, utils.js, views/, crypto-entry.ts, wallet-entry.ts; update server.ts; clean package.json
8. **Typecheck + lint + tests** — fix everything to zero warnings

---

## Verification

- `bun run build && bun run server` → visit localhost:3000, auto-generates burner key, registers, authenticates
- Open `/chat/0xANY_ADDRESS` in incognito → new identity created silently, chat opens immediately
- Export privkey hex → import on another tab → same address + history
- Delete identity → localStorage cleared, redirects to onboarding, new key generated on next visit
- Two browser windows can exchange encrypted messages via SSE
- `bun run typecheck` — zero errors
- `bun run lint` — zero warnings
- `bun run test` — all pass (server integration tests + unit tests for burner + crypto)
