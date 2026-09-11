# Agreed domain behavior

These notes capture agreed behavior separately from the glossary. They are not an implementation plan or an ADR.

## Identity and conversations

- Importing the same private key after account deletion restores the same identity. Registering it again does not restore deleted messages.
- Hiding a conversation does not delete its messages. New message activity makes it visible again.

## Intended message expiry

The implementation currently starts message lifetime when the server accepts a message; the unopened/opened lifecycle below is not yet enabled for new messages. The browser already follows the opening, reveal and synchronization rules for both delivery policies (see [browser opening and reveal](message-opening-api.md#browser-opening-and-reveal)). Agreed behavior:

- An unopened message expires 24 hours after acceptance.
- Opening a message in its conversation before that deadline starts the full sender-selected message lifetime.
- Opening applies only to successfully loaded messages. Opening a conversation does not start lifetimes for its unloaded history; loading older pages opens those messages too. Individual message bubbles need not be scrolled into view.
- A message successfully loaded while the recipient already has the conversation open starts its lifetime immediately.
- In the browser, a conversation counts as open only while it is selected in a visible, focused window. A background tab, minimized app, or locked phone does not start an unopened message's lifetime, even if SSE remains connected.
- Once a message's lifetime starts, it continues running when the recipient leaves the conversation or the app loses visibility or focus.
- In the terminal client, `read`, `watch`, and `chat` count as explicitly opening the conversation for the messages they consume. `read` opens the messages it returns; `watch` and `chat` also open incoming messages while running, including when running in the background. Listing conversations does not count as opening them.
- The server starts a message's lifetime when it first accepts an authenticated opening acknowledgement from the recipient, after the client successfully verifies and decrypts the message under the agreed opening conditions. All devices share that deadline. Retries and later openings cannot reset it, and expired messages cannot be revived. A delayed acknowledgement therefore starts the lifetime later than the actual opening.
- Incoming messages being opened remain hidden until the server confirms their opening deadline. Clients may verify and decrypt internally before confirmation, but browser display and terminal output wait for confirmation. If acknowledgement fails, keep those messages hidden and show a retryable error.
- Messages already stored when the new expiry behavior is introduced retain their original expiry deadlines; opening them cannot extend those deadlines. Only newly accepted messages use the new unopened/opened lifecycle.
- While browser synchronization is unavailable, hide messages whose expiry can still change until reconnection and authoritative refresh confirm their state. This includes intentional disconnection on focus/visibility loss and accidental disconnection. Messages with an already-confirmed final deadline may remain visible until that deadline. The sender's copy awaiting recipient opening is affected by this rule.
