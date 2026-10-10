# 0xChat redesign prototype (throwaway)

Question: what should 0xChat look like, so it feels solid and elegant, less
developer-y, with a light theme and settings that aren't a dump?

Four directions on one board, switchable with `?variant=a|b|c|d` (or ←/→ and
the floating bar), each at desktop 1280×800 and phone 390×844 with simulated
safe areas, in dark and light. Fake data only. Nothing here imports the app's
code or touches crypto, network or storage.

```sh
bun prototypes/redesign/serve.ts      # http://localhost:4173/ (REDESIGN_PORT to change)
```

"Open alone" on any frame shows that state full screen, which also works on a
phone on the same network.

| File | What |
|---|---|
| `kit.tsx` | Fake data, clock, avatars (glyphid), QR, shared copy |
| `a.tsx` `a.css` … `d.tsx` `d.css` | One direction each; tokens sit at the top of each CSS file |
| `main.tsx` `board.css` | Board, switcher, phone frames |
| `fonts/` `fonts.css` | Self-hosted OFL fonts for B, C and D (Latin + Latin Extended) |

Token names are shared across directions (`--bg`, `--surface`, `--raised`,
`--line`, `--line-strong`, `--field`, `--text`, `--text-2`, `--text-3`,
`--accent`, `--accent-text`, `--on-accent`, `--danger`, `--ok`), so the winner
maps straight onto Tailwind v4 `@theme` as `--color-*`. All text pairs are at
least 4.5:1, and accents and field borders at least 3:1, in both themes.

Once a direction is picked, capture this folder on a throwaway branch and keep
it out of main.
