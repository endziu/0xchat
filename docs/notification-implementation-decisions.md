# Notification implementation decisions

Working record for the implementation interview. The implementation spec and
GitHub issue drafts follow once the open decisions are resolved. Publishing
requires the user's review of the proposed breakdown.

## Settled foundation

[Decision #68](https://github.com/endziu/0xchat/issues/68#issuecomment-5571571314)
locks iteration on the existing notification stack. Keep SSE for live delivery,
content-free Web Push for background notifications, authenticated subscription
binding, the endpoint allowlist, the client queue/generation contract, and the
conservative notification surface. Its eight implementation priorities remain
the starting scope. The merged notification review and capability matrix provide
the research baseline; current code must be checked when specifying each fix.

## Accepted implementation decisions

### Q1: Include the agreed message-expiry behavior

Include implementation of the expiry behavior in `docs/domain-behavior.md` as a
prerequisite slice for aligning notification TTL. Other notification fixes can
proceed independently. Preserve the agreed 24-hour unopened retention limit and
the full sender-selected message lifetime starting when the recipient opens the
conversation.

Reason: current storage expires messages from acceptance, and shared browser/CLI
verification requires that same expiry calculation. Extending push TTL alone
could deliver alerts after their messages have disappeared. The prerequisite
must cover the server and both existing clients where their contracts change.

### Q2: Require visibility and focus for browser opening

A browser conversation counts as open only while it is selected in a visible,
focused window. A background tab, minimized app, or locked phone must not start
an unopened message's lifetime, even if SSE remains connected. Once started, the
lifetime continues running when the recipient leaves.

Current browser unread tracking treats the selected conversation as read without
checking visibility or focus. Update that behavior consistently with this rule.

### Q3: Terminal commands explicitly open consumed messages

Running `read`, `watch`, or `chat` counts as opening the conversation for the
messages the command consumes. `read` opens the messages it returns; `watch`
and `chat` also open incoming messages while running. This applies to background
processes and piped output; terminal window focus is not a prerequisite. Listing
conversations does not open messages.

Reason: these commands explicitly consume messages, and the current terminal
client does not track window focus. A background `watch` therefore starts message
lifetimes intentionally under this policy.

### Q4: Open only successfully loaded browser messages

Starting message lifetimes applies only to successfully loaded messages while
the browser conversation is selected, visible, and focused. Opening the
conversation must not start lifetimes for unloaded history. Loading an older
page starts those messages' lifetimes under the same conditions. Individual
message bubbles need not be scrolled into view.

Reason: the browser initially loads the newest 50 messages; starting the entire
history could expire older messages before the recipient loads them. This
refines conversation opening into message opening without changing the agreed
retention limit or lifetime duration.

### Q5: Server-accepted opening establishes one deadline

The client acknowledges message opening after successful verification and
decryption under the agreed opening conditions. The first authenticated opening
acknowledgement accepted by the server starts the full sender-selected lifetime
using server time. All devices share the resulting deadline. Retries and later
openings do not reset it, and expired messages cannot be revived.

Reason: a single authoritative deadline avoids device-clock disagreements and
repeated openings extending availability. A delayed acknowledgement starts the
lifetime later than the opening attempt; that trade-off is accepted. Q6 defines
when plaintext becomes visible.

### Q6: Confirm opening before revealing incoming plaintext

For incoming messages being opened, verify and decrypt internally, then display
in the browser or print in the terminal only after the server confirms the
opening acknowledgement and deadline. If acknowledgement fails, keep those
messages hidden and show a retryable error.

Reason: this prevents reading unopened messages while their lifetime has not
started. The additional network round trip is an accepted trade-off. A lost
response must be recoverable through the idempotent acknowledgement from Q5;
retrying must never reset a deadline or revive an expired message.

### Q7: Preserve expiry deadlines for existing messages

Messages already stored at rollout retain their existing expiry deadlines.
Opening them must not extend those deadlines. Apply the new unopened/opened
lifecycle only to newly accepted messages. Migration must preserve existing
messages rather than delete them or extend their retention.

Reason: the new rules must not retroactively change the retention schedule of
messages accepted under the old behavior. Client/server rollout must distinguish
the two expiry policies while preserving message verification.

### Q8: Queue push until the unopened retention deadline

For messages using the new lifecycle, set push TTL to the remaining time until
the message's 24-hour unopened retention deadline, independent of its
sender-selected lifetime. Do not restart that 24-hour window at push submission.

Reason: an unopened five-second message should still be able to notify an
offline recipient who returns hours later. The accepted trade-off is that an
already-queued, content-free alert may arrive after the message was opened and
expired on another device. Existing messages retain the Q7 expiry policy.

### Q9: Gate browser SSE on visibility and focus

Close the browser SSE connection when the document becomes hidden or the window
loses focus. Reconnect when visible and focused again, and refetch on
reconnection. Preserve the existing token, backoff, and connection-cap model.

Reason: a background browser connection must not indefinitely suppress push.
The server-side suppression selected in #68 remains identity-wide: another live
browser or terminal SSE connection still suppresses push to that identity's
devices. A terminal stream remains live under the Q3 background-command policy.

### Q10: Recover the full missed-message gap without resetting history

On browser SSE reconnection, refresh the conversation list and recover every
still-available missed message in the selected conversation, including gaps
larger than the current 50-message page. Preserve previously loaded history and
scroll position, merge messages by ID, apply updated expiry deadlines, and
remove expired messages. Messages arriving during recovery must be preserved.
Apply the Q4–Q6 opening rules to incoming messages recovered this way.

Reason: the current refresh replaces the selected conversation with the newest
50 messages. Reusing it unchanged could drop loaded history and leave larger
gaps. Recovery must handle concurrent live delivery as well as pagination.

### Q11: Complete identity switching when push cleanup fails

If removal of the old push subscription fails during an identity switch,
complete the switch while keeping notifications off for the new identity. Show
the cleanup failure and require explicit enabling after recovery. Never
automatically attach a surviving endpoint to the new identity.

Reason: failed cleanup must not prevent leaving the old identity. This preserves
the current identity-isolation behavior while respecting #68's requirement for
explicit removal before endpoint rebinding. If both server and browser cleanup
fail, alerts for the old identity may continue until cleanup succeeds; this
limitation was disclosed and accepted.

### Q12: Automatically repair previously enabled notifications

When the same identity returns, automatically repair previously enabled
notifications, including after VAPID key rotation, when ownership is confirmed
and browser permission remains granted. Remember notification preference per
identity on this browser. Disabling notifications survives reloads and prevents
automatic repair. A new identity still requires explicit enabling.

If the browser requires a gesture for repair, offer a **Repair notifications**
action rather than repeatedly attempting an operation that needs interaction.
The Q11 isolation rule continues to apply after cleanup failure.

Reason: recover prior opt-in without resurrecting disabled notifications or
transferring a surviving subscription to another identity.

### Q13: Keep service-worker recovery credential-free

Keep session tokens and identity keys out of the service worker. On
`pushsubscriptionchange`, the worker asks open pages to reconcile through the
authenticated subscription queue. If no page is open, recovery waits until the
next app visit. Retain session-start reconciliation as the reliable recovery
path rather than depending on worker-event support.

Reason: this preserves authenticated subscription ownership without granting
credentials to the worker. The accepted limitation is that a broken
subscription may remain unrepaired while the app is closed.

### Q14: Retry temporary push failures without another message

Automatically retry temporary push-delivery failures even if no further
messages arrive. Keep one pending wake-up per endpoint. Retry after one minute
with exponential backoff capped at one hour, respecting any longer
provider-requested delay. Stop when the relevant notification deadline passes,
and recheck the settled identity-wide SSE suppression before each attempt.

Reason: the current send path only tries again on another incoming message,
so a single message can otherwise go unannounced after a temporary failure.
This decision covers transient failures; permanent failure handling and the
operational details of pending wake-ups still need to be specified.

### Q15: Limit each identity to five browser push subscriptions

Allow at most five browser push subscriptions per identity and provide a
settings control to remove old subscriptions, including when their devices are
unavailable. At the limit, reject new subscriptions with an actionable message
instead of silently evicting a working one. Refreshing or repairing an existing
subscription must not consume an additional slot.

Reason: five accommodates several browsers and devices while bounding endpoint
storage and retry work. Explicit removal gives the identity a recovery path
when an old browser or device is no longer accessible.

### Q16: Pause push delivery on authentication or configuration failure

Authentication or configuration failures pause push delivery until repaired
rather than causing endless retries. Keep the subscription and notification
opt-in preference, expose that delivery needs repair, and resume after
successful reconciliation or a configuration fix. Continue deleting
confirmed-dead endpoints and retrying temporary failures under Q14.

Reason: an outdated VAPID subscription must not generate another failed request
on every incoming message, and failure must not silently discard the identity's
notification preference.

### Q17: Persist pending push retries across server restarts

Store the pending wake-up, notification deadline, and retry timing in SQLite,
without message content. Pending retries survive server restarts. Before
sending after restart, recheck expiry, subscription ownership, and identity-wide
SSE suppression. Removing a subscription or pruning its registration also
removes its pending retry.

Reason: a routine deployment must not lose the only remaining notification
attempt after a temporary failure.

### Q18: Bound automatic notification setup to 30 seconds

Stop waiting for automatic notification setup after 30 seconds and show an
actionable error. Time spent answering the permission prompt does not count
toward this limit. A timeout must leave identity switching usable.

Handle late browser completion safely: it must not silently enable
notifications or remove a newer subscription. A timeout on the caller's promise
does not by itself cancel the underlying browser operation, so lifecycle tests
must exercise late resolution as well as the timeout itself.

### Q19: Require compatible clients for the new expiry lifecycle

Once the new lifecycle is enabled, older browser tabs and CLI versions may be
required to update before continuing to message. Return a clear **client update
required** error for incompatible clients. Updated clients support both existing
messages' original deadlines and newly accepted messages' opening-based
deadlines.

Reason: old clients must not display new messages without acknowledging opening
or reject valid messages because the expiry calculation changed. Preserve
existing messages and their deadlines as required by Q7.

### Q20: Hide messages with changeable deadlines while out of sync

While browser synchronization is unavailable, hide messages whose expiry can
still change until reconnection and authoritative refresh confirm their state.
This applies both to intentional SSE disconnection on focus/visibility loss
and to accidental disconnection. Messages with an already-confirmed final
deadline can remain visible until that deadline.

Reason: another device can open a message and change its deadline while this
browser is disconnected. In particular, the sender's copy awaiting recipient
opening must not remain visible using a stale unopened deadline. Some content
therefore disappears when the window loses focus or connectivity; that
visibility trade-off is accepted.

## Remaining confirmation

Agree on the test boundaries and confirm shared understanding before
synthesizing the implementation spec. Then draft tickets and present their
acceptance criteria and dependencies for review before publishing.

## Implementation details to make explicit in the spec

- Keep delivery-lifecycle metadata separate from the signed envelope version;
  preserve ciphertext, signatures, and original legacy deadlines. Upgrade gates
  must also cover SSE token admission and existing streams.
- Publish authoritative expiry changes to both participants' connected clients,
  reconcile them after reconnect, and replace existing timers when a deadline
  changes. The terminal must process expiry updates without printing a message
  twice. Historical terminal output cannot be retracted.
- Remote subscription removal must win over automatic repair. Distinguish
  intentional revocation from provider-dead endpoints and missing server state;
  a returning remotely removed browser requires explicit enabling.
- Endpoint replacement must retain the owned slot atomically at the cap. Keep
  list/removal operations identity-scoped and identify subscriptions without
  displaying secret endpoint URLs.
- Coalesce pending wake-ups without resetting provider delays or backoff;
  an in-flight attempt must not consume newer pending work. Define how SSE
  suppression disposes of pending work consistently with initial-send
  suppression. Pause state must survive restart while deadlines still apply.
- Pruning removes subscriptions and retry work transactionally. Ordinary session
  expiration does not remove subscriptions.
- Coordinate shared browser subscription state across tabs as well as within
  the existing per-hook queue/generation contract. Timeout and stale-operation
  cleanup must not mutate a newer registration.
- Preserve the generic notification, tag, and conservative click behavior:
  deterministically focus an existing chat client without replacing its active
  conversation; otherwise open the chat list. Keep delivered pushes visible
  and worker recovery credential-free.

These details follow the accepted behavior and will be visible in the spec and
ticket drafts for review; they do not reopen the settled architecture.
