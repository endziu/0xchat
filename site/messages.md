# Messages and lifetimes

Every message in 0xChat is deleted on a timer. The timer the sender chooses only starts when the
recipient actually opens the message.

## Choosing a lifetime

Pick a lifetime in the composer before sending: **5s, 10s, 30s, 1m, 5m, 30m, 1h, 6h or 24h**.

In **Settings → Message lifetime** you can set a default, or choose **Remember last** to reuse
whatever you picked most recently.

## When a message disappears

| Situation | What happens |
|---|---|
| Recipient opens the message | It is deleted when its lifetime ends, counted from the moment it was opened. |
| Recipient never opens it | It is deleted 24 hours after it was sent. |
| Either person clears the conversation | Every message in it is deleted immediately, for both of you. |

Once a lifetime has started it cannot be paused, reset or extended, and an expired message cannot
be brought back. The deadline is the same on every device.

## What counts as "opened"

A message is opened when it has loaded in a conversation you have **open in a visible, focused
window**. You do not need to scroll to each message.

These do **not** open a message:

- the app sitting in a background tab, a minimized window or a locked phone;
- seeing the conversation in your conversation list;
- older history you have not loaded yet (loading older messages opens them).

If a message arrives while you already have its conversation open and focused, its lifetime starts
immediately.

## Why messages are sometimes hidden

0xChat only shows a newly opened message once the server has confirmed its deadline, so every
device agrees on when it disappears. If that confirmation fails you will see an error you can
retry.

While the app is disconnected, or the window loses focus, messages whose deadline could still
change are hidden until the app reconnects and refreshes. Messages whose deadline is already fixed
stay visible until they expire. This also applies to your own sent messages that the recipient has
not opened yet.

## What a lifetime does not protect against

A lifetime deletes the message from 0xChat. It cannot stop the other person from taking a
screenshot, copying the text or photographing their screen. Only send what you are comfortable
with the recipient keeping.
