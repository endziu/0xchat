# Privacy and security

## What stays private

- **Message contents.** Your browser encrypts each message before sending it, so the server
  that delivers it cannot read it. The recipient's app also checks that the message was signed
  with the sender's private key. This confirms which address sent it, not who owns that address.
- **Names you give conversations.** These are saved only in your browser.
- **Message text in notifications.** Alerts tell you a message arrived without including its
  contents.

## What the server can see

To deliver messages and delete them on time, the server can see:

- which addresses exchange messages, and when;
- roughly how large each message is;
- when a message is opened;
- your IP address while connected, which it uses to limit spam and excessive requests;
- the delivery address your browser uses for notifications, if you turn them on.

You do not have to give 0xChat your real name, but that does not make you completely anonymous.
If someone connects your chat address to you, activity associated with that address may also
be linked to you.

## What is deleted, and when

- **Messages** are deleted when their timer runs out, 24 hours after sending if never opened,
  or immediately when either person clears the conversation.
  See [Disappearing messages](./messages.md).
- **Inactive addresses** are removed from the server after 30 days without activity. Opening
  the app with your key makes your address available again.
- **Your account and its messages** are removed when you
  [burn your identity](./your-key.md#burn-your-identity). A saved key lets you reuse the address,
  but it cannot restore deleted messages.

## Usage statistics

The server counts how many different accounts use 0xChat each day. To avoid counting an account
more than once, it uses temporary codes that change daily. After the day ends, those codes are
deleted and only the daily total is kept.

These statistics do not include message contents or IP addresses, and do not use third-party
analytics services.

## How to protect your account

- Keep your private key and its backup secret. Anyone with the key can read your available
  messages and send messages as you. Never reuse a key from a crypto wallet that holds anything
  of value.
- Remember that disappearing messages can still be copied or photographed.
- Lock your device and take care on shared computers. 0xChat cannot protect your messages from
  someone who has access to your unlocked device or from harmful software running on it.
