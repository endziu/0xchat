# 0xChat

0xChat is pseudonymous messaging between identities identified by Ethereum addresses, with messages that expire after a sender-selected lifetime.

## Language

**Identity**:
A pseudonymous chat identity controlled by a private key and identified by an Ethereum address.
_Avoid_: Account, wallet, user

**Registration**:
An identity’s enrollment in 0xChat, allowing others to message it.
_Avoid_: Identity, account

**Conversation**:
A one-to-one exchange between two identities, independent of whether any messages remain.

**Conversation partner**:
The other identity in a conversation.
_Avoid_: Contact

**Conversation label**:
A private, locally assigned name for a conversation partner.
_Avoid_: Username, display name

**Hide conversation**:
The local removal of a conversation from the conversation list without deleting its messages.
_Avoid_: Delete conversation, delete contact

**Message deletion**:
The removal of messages, including when they expire, rather than merely hiding their conversation from view.
_Avoid_: Hide conversation

**Message lifetime**:
The sender-selected duration a message remains available once the recipient opens its conversation.
_Avoid_: Retention period, time since sending

**Unopened retention limit**:
The maximum time a message may wait for the recipient to open its conversation.
_Avoid_: Message lifetime
