# UI / UX report

Date: 2026-09-27 · Version reviewed: v0.5.2 (`main` @ b8eba02)

## 1. Names and identity (your example, and its neighbours)

### 1.1 The label stops at the conversation list — P1
`labels` lives in `useConversations` inside `ChatView`, and only `ConversationList`
receives it. `MessagePane` gets only `recipientAddress`, so:

- The chat header shows the raw address: all 42 characters on desktop, truncated on
  phones (`MessagePane.tsx:199`).
- Each message group's sender line is `shortAddr(msg.sender)` (`MessagePane.tsx:256`).
- The "has left the chat" notice uses the truncated address (`ChatView.tsx:53`).

In the test, the phone renamed its partner to "Alice". The list said **Alice**, but
the open chat still said **0xb9bb…574b** at the top and on each of her messages.

**Suggestion.** Add a single `displayName(address, labels, self)` helper that
returns the label, "You" for your own address, and otherwise the truncated address.
Use it everywhere an address is shown to a person. Pass `label` into `MessagePane`.
In the header, show the name large and the address small and dim beneath it,
for example `Alice` over `0xb9bb…574b`, so the address can still be checked.

### 1.2 Rename from inside the conversation — P2
Right now you can only rename from the list row, using a pencil that appears on
hover. It's natural to want to name someone right after reading "hey, it's Alice".
Make the name in the chat header tappable to rename, and offer
"Add a name" when there's no label yet. The same field could appear in the
new-conversation form ("Name (optional)").

### 1.3 "You" instead of your own address — P1
In the thread, your messages are signed `0x32bd…8b54`. Almost nobody remembers
their own burner address. Show **You**, or drop the sender line for your own
messages and rely on the bubble style (see 4.1).

### 1.4 Addresses change letter case — P3
The app bar shows the checksummed form (`0xb9bB…574b`), while the list and
messages show lowercase (`0xb9bb…574b`). The same identity looking different
undermines trust in an app where the address *is* the identity. Pick one form for
display (checksummed is the Ethereum convention) and use it everywhere.

### 1.5 Make truncated addresses easier to tell apart — P3
`0x4ae6…330d` and `0x4ae6…9f1c` look almost identical. Give each address a
deterministic avatar: a small blockie/identicon, or just a colored hexagon
matching the ⬡ brand mark. Use it in the list, the chat header and on sender
lines. It shows at a glance who is who, even before a label exists.

---

## 2. Conversation list

### 2.1 Unread is hard to see — P2
Unread is shown by a 6px white dot only (`ConversationList.tsx:132`). The name keeps
the same weight and color, and unlabeled rows are `text-neutral-600`, very dim.
Make unread rows bold and bright, and put the dot on the left edge where the eye
starts reading. Show a count ("3") of messages that arrived during this
session. The count is kept only in the browser and resets on reload, which
keeps the change client-only.

### 2.2 Stale conversations are unexplained — P3
Conversations with no active messages are shown at `opacity-50` with a
`title="No active messages"` tooltip. Tooltips don't exist on touch screens.
Add a visible "no messages" hint, or group these rows under a divider such as
"Earlier".

### 2.3 Row actions on phones — P2
On touch screens, every row always shows a pencil and a trash icon. They take
about 40% of the row width (see the phone screenshots), and the trash is one
tap away from the row you meant to open. Options:
- Move rename into the chat header (1.2), and hiding the conversation into a menu
  there.
- Or use swipe-to-reveal or long-press on rows.

Either way, the list becomes names and times only, which is how chat apps
normally look.

### 2.4 The inline rename field — P3
The field appears with no placeholder, no Save or Cancel buttons, and saves on
blur. As a result, an accidental tap outside commits the edit. Add
`placeholder="Name this conversation"` and show a small check and X, as the
new-chat form does.

---

## 3. Destructive actions and what they're called

### 3.1 Two trash icons, two meanings — P1
- The trash on a list row **hides** the conversation locally
  (`deleteContact`). Its title is "Delete".
- The trash in the chat header **clears every message for both people**.

Same icon, same "tap twice" pattern, very different consequences. CONTEXT.md
already names these precisely: *Hide conversation* and *Clear conversation*.
Use those words in the UI. Give Hide an `EyeOff` or archive icon. Keep the
trash for Clear, and label it "Clear for both of you". The second tap should
show that text, not just a check mark.

### 3.2 Hiding a conversation deletes its label — P2
`deleteConversation` also deletes the label (`useConversations.ts`). When the
person messages again, the conversation comes back unnamed. Hiding is meant to
be reversible, so keep the label.

### 3.3 Burn identity — P1
- The icon is `LogOut` (`Layout.tsx:117`), which everyone reads as a harmless
  sign-out. What it actually does is permanently delete your identity and your
  messages.
- It sits in the header next to Copy, Link and QR, one mis-tap away.
- The confirmation is an 8-second popover.

Move it into Settings, in a "Danger zone" section below Export. Use a flame
icon or a plain red "Burn identity…" button. Make the user show they have a
backup first: either Export was used this session, or they type "burn". This
also frees a header slot on phones, where five 44px icons already crowd the logo.

### 3.4 Two-tap confirmations that only change the icon — P3
Clear, Hide and Import confirm by swapping the icon for a ✓ and changing the
`title`. On touch screens the title is invisible, so the only feedback is an
icon change for 3 seconds. Replace the icon with visible text, such as
"Clear?" or "Hide?".

---

## 4. The message thread

### 4.1 You can't tell your messages from theirs at a glance — P2
Both sides are left-aligned with the same layout. The only differences are the
text brightness (neutral-400 vs neutral-200) and the left-border shade. That
fits the terminal look but costs readability. Ways to keep the look:
- Put a `>` prompt or a colored bar on your own lines.
- Right-align your own groups only on phones.
- Use a single accent color (the green of the "Live" dot) for your messages'
  border.

### 4.2 Messages start at the top of the pane — P2
With only a few messages, they sit at the top and a large empty area separates
them from the composer (clear on the phone screenshot). Chat apps anchor the
conversation to the bottom. Add a `mt-auto` spacer as the first child of the
scroll column (`MessagePane.tsx:228`).

### 4.3 Grouped messages hide their times — P3
Times are shown only when the minute changes, and otherwise appear on hover
(`MessagePane.tsx:250`). Touch screens have no hover, so on phones those times
can never be seen. Consider tap-to-reveal, or just leave the minute gap as it is.

### 4.4 No date separators — P3
With 24-hour lifetimes and 24-hour unopened retention, a conversation can span
midnight, but only `HH:MM` is shown. Add "Today" / "Yesterday" dividers.

### 4.5 No state for messages you've sent — P2
After tapping Send, the text stays in the composer until the server accepts
it, and the send button is only disabled. Nothing says "sending…". Once sent,
nothing tells the sender whether the message was opened. Under recipient
opening, the sender's copy does learn `opened_at` through expiry updates, so
the data already exists. See 5.2.

### 4.6 Tapping an image opens a raw data URL in a new tab — P3
`window.open(msg.plaintext)` opens a `data:` URL, which many browsers block or
show as a blank tab. It also takes the decrypted image outside the app. Use an
in-app full-screen viewer that closes on tap or Esc.

### 4.7 Long links break mid-word — P3
Links use `break-all`, so `exampl` / `e.com` split across lines. Use
`overflow-wrap:anywhere`, or shorten the displayed link (`example.com/…/path`).

### 4.8 "Load older messages" — P3
This button appears whenever `hasMore` is true. Loading older messages
automatically when the user scrolls near the top (IntersectionObserver) would
make the button unnecessary.

---

## 5. Expiry: the core of the product, and currently the hardest part to read

### 5.1 "expires HH:MM" is misleading — P1
- It appears **only on the first message of each group** (`MessagePane.tsx:265`).
  Later messages in the group have different expiry times, but it looks as if the
  line applies to all of them.
- It's a clock time with no date: a 24-hour message sent at 23:39 says
  "expires 23:39".
- Messages vanish without warning when they expire.

**Suggestion.** Put a small countdown on **every** message, perhaps shown only on
hover or tap for grouped messages: `29m`, `4h`, `12s`. Change its style as the
end nears: dim → amber below 10% remaining, and a brief fade before removal.
For a burn-after-reading app this is the signature interaction, so it deserves
the design effort.

### 5.2 The unopened state is invisible to the sender — P1 once `RECIPIENT_OPENING` is on
For an unopened message, the sender's copy has `expires_at` set to the 24-hour
retention deadline. The UI would show "expires HH:MM", a time 24 hours out, next
to a message you set to 30 seconds. Show three states:

- `sent · waits up to 24h` (unopened)
- `opened · 29m left` (lifetime running)
- `expired` (fade out)

Whether "opened" counts as a read receipt, and whether that's acceptable, is a
product decision. The data already reaches the sender, so showing it adds no new
information leak.

### 5.3 The lifetime chip in the composer — P3
The `⏱ 30m` pill works well. It can say more: add a tooltip or aria text such as
"Messages you send disappear 30m after they're opened". Make short lifetimes
(≤ 1m) visually louder so an accidental 5s choice is hard to miss.

---

## 6. Composer

- **The attach button reuses the "New conversation" icon** (`Plus`,
  `MessagePane.tsx:290`). Use `ImagePlus` or `Paperclip`. — P3
- **Sending to a burned partner.** After `user:disconnected`, the composer stays
  active and sends fail with a toast. Disable the composer with a line such as
  "This identity was deleted. Messages can't be delivered." — P2
- **Enter sends on phones.** Enter always sends, so on phones there is no way to
  type a newline. Most mobile chat apps make Enter insert a newline on
  touch devices and rely on the Send button. — P3
- **Drag and drop images** on desktop. Paste works; drop does not. — P3

---

## 7. App bar and the shell

- **"Reconnected" on every load — bug.** `App.tsx:15` starts `sseConnected` at
  `false`, so `Layout` sees a false → true transition on the first connection and
  shows the "Reconnected" toast (`Layout.tsx:50`). It appeared in both test
  sessions. Start the value as `undefined`, or skip the first transition. On
  desktop the toast also covers the header actions for 3 seconds.
- **The phone header does not change in a conversation.** On phones, the chat
  view shows two stacked 44px bars: the app bar (identity actions) and the chat
  header. While a conversation is open on phones, hide the app bar or reduce it
  to the chat header, as native messengers do. That frees vertical space when
  the keyboard is up.
- **Identity actions are scattered.** Copy address, copy link, QR and the
  address itself are separate header buttons. Group them in a single "Me"
  sheet: the address and its avatar, a QR code, Copy, and **Share** via
  `navigator.share` on phones, which is the most natural way to hand someone
  your chat link. The header would then hold ⬡ 0xChat, the live dot, Me and
  Settings.
- **The live indicator on phones is only a dot.** Fine while connected. When
  disconnected, show a thin "Reconnecting…" strip instead of a grey dot plus a
  toast that disappears.
- **The version number is fixed in the bottom-left corner on desktop** and
  overlaps the conversation list. It's already shown in Settings, so drop it
  here. — P3
- **The desktop back arrow.** The chat header shows ← even when the list is
  visible beside it. Hide it at `sm:`. — P3

---

## 8. Empty states and first run

A new identity lands on "No conversations yet" / "No conversation selected",
two dim grey lines. This is the moment to teach the whole product:

- **Empty list:** "Share your address to start" with your QR code inline, plus
  Copy link / Share and "Start a conversation" buttons.
- **No conversation selected (desktop):** repeat the same, or show a short
  explainer: end-to-end encrypted · messages disappear · your key is your
  account.
- **Backup nudge:** "Export your key or you lose this identity" is currently
  only in the README. After the first sent message, show a dismissible banner
  "Back up this identity" that opens Export.
- **New chat form:** the input isn't focused after clicking **+** on desktop.
  Observed in headless Chromium: `autofocus` is ignored because the + button
  keeps focus. Focus it with a ref in an effect. Also validate as the user
  types (address shape → ✓), and accept a pasted `https://…/chat/0x…` link,
  as the QR parser already does.
- **"No messages yet"** in a new conversation could explain the rules:
  "Messages here are end-to-end encrypted and disappear after the lifetime you
  pick below."

---

## 9. Settings, modals, accessibility

- **The notifications control is ambiguous.** A button labelled **Off** turns
  notifications *on* (`SettingsModal.tsx:82-90`). Use a real switch
  (`role="switch"`, `aria-checked`) with the label "Notify me of new messages".
  When permission is Blocked, say how to unblock it.
- **The settings order puts the riskiest item first.** Export private key sits
  at the top. Suggested order: Profile (address, QR) → Message lifetime →
  Notifications → Backup (export/import) → Danger zone (burn).
- **Modals.** `SettingsModal` has `role="dialog"` and Esc but no focus trap
  and no focus restore. `QRModal` has no `role="dialog"`, no Esc handling and
  no labels on the mode buttons besides `title`. The burn popover is labelled
  `alertdialog` but doesn't move focus.
- **Contrast.** Much secondary text is `text-neutral-600/700` on black:
  unlabeled addresses in the list, empty states, the version number. On black, neutral-700
  is about 2:1 and neutral-600 about 2.7:1, both below WCAG AA (4.5:1). Raise secondary text to at least
  neutral-500.
- **Live region.** Incoming messages aren't announced. Add `aria-live="polite"`
  on the thread, or a visually hidden "New message from Alice".
- **Hover-only reveals** (row actions, grouped times) are correctly guarded
  with `can-hover`, but make sure keyboard focus reveals them too:
  `focus-within` on the row.

---

## 10. Look and feel

The monospace, black, hairline-border terminal style is distinctive and fits
the product: burner identities, hex addresses, ephemerality. Keep it. What's
missing is **hierarchy and a single accent**:

- **One accent color.** Everything is neutral except link blue, error red and
  the green live dot. Choose one brand accent (the live-dot green, or an
  amber "ember" for things that burn) and use it only for your own messages,
  unread state, focus rings and the expiry countdown near its end. Links could
  then use the accent instead of an off-system sky-blue.
- **Type scale.** Almost everything is `text-sm` or `text-base` in the same
  mono font. The desktop 150% root scale makes the UI look zoomed, not
  designed. Try 125%, and a clearer ramp:
  name (base, bright) → message (base) → meta (xs, dim).
- **The brand mark.** "⬡ 0xChat" uses a text glyph. An SVG hexagon (the
  favicon) would render the same everywhere and could double as the avatar
  frame (1.5).
- **Motion.** None today. Small, cheap touches would help: a new message fading
  in, expiring messages fading and collapsing, a toast sliding in. All should
  respect `prefers-reduced-motion`.
- **Phone composer.** The rounded pill composer is the only rounded element in
  an otherwise square UI. Either commit to squares (consistent with the
  terminal look) or round the lifetime chip, the toasts and the modals to
  match.
- **Scrollbar color** `#333` is hard-coded. Define colors as CSS tokens in one
  place so the accent and future themes are one-line changes.

---

## 11. Bugs found along the way

1. **"Reconnected" toast on first connect.** See section 7 (`App.tsx:15`,
   `Layout.tsx:46-53`).
2. **Disconnect notice never clears.** `disconnectNotice` is set in
   `ChatView.tsx:53` and never reset. After any partner burns their identity,
   "0x… has left the chat" stays above **every** conversation until reload.
   Store the address with the notice and show it only when it matches
   `recipientAddress`.
3. **New-chat input not focused** after clicking **+** on desktop. See section 8.
4. **Hiding a conversation deletes its label.** See 3.2.

---

## Suggested order of work

1. **Quick wins, about a day:** bugs 1–4; `displayName()` used everywhere,
   plus "You" (1.1, 1.3); rename Hide vs Clear and change the icon (3.1);
   `mt-auto` anchor (4.2); attach icon; notifications switch.
2. **Identity polish:** avatars (1.5); rename from the header (1.2);
   consistent checksum casing (1.4); the "Me" sheet with Share; moving Burn into
   Settings (3.3).
3. **Expiry design:** a per-message countdown, the unopened/opened states and
   fade-out (5.1, 5.2). This is the feature that makes 0xChat what it is, and
   it's worth prototyping first; the `prototype` skill fits.
4. **First run and empty states** (8), then visual system work (10): accent
   color, type scale, tokens, motion.
