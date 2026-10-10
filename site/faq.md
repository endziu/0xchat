# FAQ

## I lost my key. Can I recover my identity?

No. Nobody, including the server, has a copy of your private key. Start with a new identity and
share the new address. Next time, [back up your key](./your-key.md#back-up-your-key).

## Sending says "Recipient not registered"

The address has never opened 0xChat, or its owner has been inactive for 30 days, or they burned
their identity. They need to open the app (with their key) before you can message them.

## Sending says "Too many requests"

You hit a rate limit that protects the server from spam. Wait a minute and try again.

## A message I sent disappeared before the other person read it

Unopened messages are deleted 24 hours after sending. If they opened it, its lifetime started then
and it was deleted when the lifetime ran out. Clearing the conversation from either side also
deletes everything.

## Messages vanished when I switched tabs

Messages whose deadline could still change are hidden while the app is in the background or
disconnected, and come back when you return. See
[why messages are sometimes hidden](./messages.md#why-messages-are-sometimes-hidden).

## Can I use 0xChat on my phone and my computer?

Yes. Import the same key on both. See
[Use the same identity on several devices](./your-key.md#use-the-same-identity-on-several-devices).

## Does 0xChat cost anything, or touch the blockchain?

No. There are no tokens, gas or transactions. 0xChat only borrows Ethereum's key and address
format.

## Can I change my address?

Your address comes from your key, so a new address means a new identity. You can create one by
burning the current identity, or by importing a different key.
