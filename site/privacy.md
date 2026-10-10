# Privacy and security

## What is protected

- **Message contents.** Each message is encrypted in your browser to the recipient's public key
  and signed with your key. The server stores and forwards only ciphertext it cannot read, and
  the recipient's app checks the signature before showing anything.
- **Names you give conversations.** They stay in your browser.
- **Notifications.** Push alerts carry no message content.

## What the server can see

The server has to route messages, so it knows:

- which addresses talk to each other, and when;
- roughly how large each message is;
- when a message was opened, in order to delete it on time;
- your IP address while connected, used for rate limiting;
- your browser's push endpoint, if you enabled notifications.

0xChat is pseudonymous, not anonymous: anyone who can link your address to you can link your
conversations to you.

## What is deleted, and when

- Messages: when their lifetime ends after opening, 24 hours after sending if never opened, or
  immediately when either side clears the conversation. See [Messages and lifetimes](./messages.md).
- Registrations: after 30 days without activity.
- Everything for your identity: when you [burn it](./your-key.md#burn-your-identity).

## Usage statistics

The server counts how many distinct identities were active each day. Each day uses a fresh random
key to deduplicate, and the per-identity data is thrown away the next day; only the daily totals
are kept. No message contents, IP addresses or third-party analytics are involved.

## Your side of the bargain

- Anyone who gets your private key can read messages addressed to you and impersonate you. Keep
  the backup safe and never reuse a wallet key.
- Expiring messages cannot stop a recipient from copying or photographing them.
- Your device's own security (screen lock, malware, shared computers) still applies.
