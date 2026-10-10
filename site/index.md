# What is 0xChat?

0xChat is an end-to-end encrypted chat where an Ethereum address is your identity and every
message expires.

There is no signup, email, phone number, username, friend request or wallet connection. Open the
app and it creates a fresh **burner identity** in your browser. Share its address or QR code, and
anyone who has it can message you.

## What makes it different

- **Your address is your account.** It comes from a private key that only your browser holds.
- **Messages are encrypted and signed in your browser** before they are sent. The server only
  ever stores ciphertext it cannot read.
- **Messages disappear.** The sender picks how long a message lasts once it is opened, from
  5 seconds to 24 hours. Unopened messages are deleted 24 hours after sending.
- **Nothing to install.** It runs in any modern browser and can be added to your home screen.

## What it is not

0xChat uses Ethereum cryptography and address formatting, but chatting is **not an onchain
transaction**. You do not need a wallet extension, a network connection to Ethereum, tokens or
gas. Nothing you do in 0xChat is published to a blockchain.

::: warning Use a dedicated burner key
Your private key is your account, and it lives in browser storage. Never import a key from a
wallet that holds anything of value. See [Your key](./your-key.md).
:::

## Next steps

- [Getting started](./getting-started.md): share your address and start a conversation.
- [Messages and lifetimes](./messages.md): exactly when messages disappear.
- [Your key](./your-key.md): back up your identity so you don't lose it.
