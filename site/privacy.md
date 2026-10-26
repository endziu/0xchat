# Privacy and security

## What stays private

- **Message contents.** Encrypted in your browser; the server cannot read them. Each message is
  also signed, so the recipient's app can verify which address sent it. That proves the
  address, not the person behind it.
- **Conversation names.** Stored only in your browser.
- **Notifications.** They contain no message text and no sender.

## What the server can see

To deliver messages and delete them on time, the server knows:

- which addresses message each other, and when;
- the approximate size of each message;
- when each message is opened;
- your IP address while you're connected, used to limit spam;
- your browser's notification endpoint, if notifications are on.

hushhash doesn't ask who you are, but that isn't the same as anonymity. If someone links your
address to you, they can link its activity to you too.

## What is deleted, and when

- **Messages:** when their timer runs out, after 24 hours unopened, or when the conversation is
  cleared. See [Disappearing messages](./messages.md).
- **Addresses:** after 30 days of inactivity. See [Inactive addresses](./your-key.md#inactive-addresses).
- **Accounts:** with all their messages, when you
  [burn your identity](./your-key.md#burn-your-identity).

## Usage statistics

The server counts how many accounts are active each day. To count each one once, it uses
identifiers that change daily and are deleted when the day ends; only the totals are kept. No
message contents, IP addresses or third-party analytics are involved.

## What hushhash can't protect against

- Someone who has your private key.
- The other person copying or photographing a message before it disappears.
- Someone using your unlocked device, or malware running on it.
