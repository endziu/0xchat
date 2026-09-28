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
"Add a name" when there's no label yet. This becomes the only place to rename
(see 2.3). The same field could appear in the new-conversation form
("Name (optional)").

### 1.3 "You" instead of your own address — P1
In the thread, your messages are signed `0x32bd…8b54`. Almost nobody remembers
their own burner address. Show **You**, or drop the sender line for your own
messages and rely on the bubble style (see 4.1).

### 1.4 Make truncated addresses easier to tell apart — P3
`0x4ae6…330d` and `0x4ae6…9f1c` look almost identical. Give each address a
deterministic avatar: a small hexagon, matching the ⬡ brand mark (reuse the
favicon's SVG), colored with a hue derived from the address. Use it in the list,
the chat header and on sender lines. It shows at a glance who is who, even
before a label exists.

---

## 2. Conversation list

### 2.1 Unread is hard to see — P2
Unread is shown by a 6px white dot only (`ConversationList.tsx:132`). The name keeps
the same weight and color, and unlabeled rows are `text-neutral-600`, very dim.
Make unread rows bold and bright, and put the dot on the left edge where the eye
starts reading.

### 2.2 Stale conversations are unexplained — P3
Conversations with no active messages are shown at `opacity-50` with a
`title="No active messages"` tooltip. Tooltips don't exist on touch screens.
Show a visible "no messages" hint on these rows.

### 2.3 Row actions on phones — P2
On touch screens, every row always shows a pencil and a trash icon. They take
about 40% of the row width (see the phone screenshots), and the trash is one
tap away from the row you meant to open. Move rename (1.2) and Hide (3.1) into
the chat header and remove both from the list. The list then shows names and
times only, which is how chat apps normally look. This also retires the inline
rename field, which had no placeholder, no Save or Cancel, and saved on blur.

---

## 3. Destructive actions and what they're called

### 3.1 Two trash icons, two meanings — P1
- The trash on a list row **hides** the conversation locally
  (`deleteContact`). Its title is "Delete".
- The trash in the chat header **clears every message for both people**.

Same icon, same "tap twice" pattern, very different consequences. CONTEXT.md
already names these precisely: *Hide conversation* and *Clear conversation*.
Use those words in the UI. Give Hide an `EyeOff` or archive icon. Keep the
trash for Clear.

The two-tap confirmations (Clear, Hide, Import) currently swap the icon for a ✓
and change the `title`. On touch screens the title is invisible, so the only
feedback is an icon change for 3 seconds. Show visible text on the second tap
instead: "Hide?", "Import?", and "Clear for both of you?".

### 3.2 Hiding a conversation deletes its label — P2
`deleteConversation` also deletes the label (`useConversations.ts`). When the
person messages again, the conversation comes back unnamed. Hiding is meant to
be reversible, so keep the label.

### 3.3 Burn identity — P1
- The icon is `LogOut` (`Layout.tsx:117`), which everyone reads as a harmless
  sign-out. What it actually does is permanently delete your identity and your
  messages.
- It sits in the header next to Copy, Link and QR, one mis-tap away.

Move it into Settings, in a "Danger zone" section below Export, as a plain red
"Burn identity…" button (or a flame icon). Keep the existing two-step confirm.
This also frees a header slot on phones, where five 44px icons already crowd
the logo.

---

## 4. The message thread

### 4.1 You can't tell your messages from theirs at a glance — P2
Both sides are left-aligned with the same layout. The only differences are the
text brightness (neutral-400 vs neutral-200) and the left-border shade. That
fits the terminal look but costs readability. Give your own messages' left
border the accent color (see 10). The layout stays the same.

### 4.2 Messages start at the top of the pane — P2
With only a few messages, they sit at the top and a large empty area separates
them from the composer (clear on the phone screenshot). Chat apps anchor the
conversation to the bottom. Add a `mt-auto` spacer as the first child of the
scroll column (`MessagePane.tsx:228`).

### 4.3 No date separators — P3
With 24-hour lifetimes and 24-hour unopened retention, a conversation can span
midnight, but only `HH:MM` is shown. Prefix times from before today with
"Yesterday" (`Yesterday 23:39`). No separators are needed for a span of a day
or two.

### 4.4 No "sending" state — P2
After tapping Send, the text stays in the composer until the server accepts
it, and the send button is only disabled. Nothing says "sending…". Show it.
Whether the sender should also see "opened" is deferred with 5.2.

### 4.5 Tapping an image opens a raw data URL in a new tab — P3
`window.open(msg.plaintext)` opens a `data:` URL, which many browsers block or
show as a blank tab. It also takes the decrypted image outside the app. Instead,
tapping the image should toggle it between thumbnail and full width in place.

---

## 5. Expiry: the core of the product, and currently the hardest part to read

### 5.1 "expires HH:MM" is misleading — P1
- It appears **only on the first message of each group** (`MessagePane.tsx:265`).
  Later messages in the group have different expiry times, but it looks as if the
  line applies to all of them.
- It's a clock time with no date: a 24-hour message sent at 23:39 says
  "expires 23:39".

**Suggestion.** Show the remaining time on **every** message, e.g. `29m`, `4h`,
`12s`, perhaps revealed on hover or tap for grouped messages. Compute it when
the message renders. No live ticking timer and no styling that changes as
expiry nears.

### 5.2 The lifetime chip in the composer — P3
The `⏱ 30m` pill works well. It can say more: add a tooltip or aria text such as
"Messages you send disappear after 30m". Make short lifetimes (≤ 1m) visually
louder so an accidental 5s choice is hard to miss.

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

---

## 7. App bar and the shell

- **"Reconnected" on every load — bug.** `App.tsx:15` starts `sseConnected` at
  `false`, so `Layout` sees a false → true transition on the first connection and
  shows the "Reconnected" toast (`Layout.tsx:50`). It appeared in both test
  sessions. Start the value as `undefined`, or skip the first transition. On
  desktop the toast also covers the header actions for 3 seconds.
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
two dim grey lines. One line of guidance each is enough:

- **Empty list:** "Share your address to start", pointing at the existing Copy
  link and QR buttons, plus a "Start a conversation" button.
- **No conversation selected (desktop):** a one-line explainer: end-to-end
  encrypted · messages disappear · your key is your account.
- **Backup warning:** "Export your key or you lose this identity" is currently
  only in the README. Put a static line saying so next to Export in Settings.
- **New chat form:** the input isn't focused after clicking **+** on desktop.
  Observed in headless Chromium: `autofocus` is ignored because the + button keeps focus. Focus it with a ref in an effect.
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
  `alertdialog` but doesn't move focus. Build them on the native `<dialog>`
  with `showModal()`, which provides Esc, focus trapping and the backdrop.
  Restoring focus on close is one line.
- **Contrast.** Much secondary text is `text-neutral-600/700` on black:
  unlabeled addresses in the list, empty states, the version number. On black, neutral-700
  is about 2:1 and neutral-600 about 2.7:1, both below WCAG AA (4.5:1). Raise secondary text to at least
  neutral-500.
- **Live region.** Incoming messages aren't announced. Add `aria-live="polite"`
  on the thread.
- **Hover-only reveals** (grouped times) are correctly guarded with
  `can-hover`, but make sure keyboard focus reveals them too: `focus-within`
  on the message group.

---

## 10. Look and feel

The monospace, black, hairline-border terminal style is distinctive and fits
the product: burner identities, hex addresses, ephemerality. Keep it.

What's missing is **a single accent**. Everything is neutral except link blue,
error red and the green live dot. Choose one brand accent (the live-dot green,
or an amber "ember" for things that burn) and use it only for your own messages
(4.1), unread state and focus rings. Links could then use the accent instead of
an off-system sky-blue.
