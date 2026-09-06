# Agreed domain behavior

These notes capture agreed behavior separately from the glossary. They are not an implementation plan or an ADR.

## Identity and conversations

- Importing the same private key after account deletion restores the same identity. Registering it again does not restore deleted messages.
- Hiding a conversation does not delete its messages. New message activity makes it visible again.

## Intended message expiry

The implementation currently starts message lifetime when the server accepts a message. The following agreed behavior is not yet implemented:

- An unopened message expires 24 hours after acceptance.
- Opening the conversation before that deadline starts the full sender-selected message lifetime.
- A message arriving while the recipient already has the conversation open starts its lifetime immediately.

Whether a selected conversation in a background app or on a locked phone counts as open remains unresolved.
