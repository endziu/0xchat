# 0xChat user guide

How to use 0xChat, protect your identity, understand its privacy model, and solve common problems.

## Getting started

### 1. Open the app

On the first visit, 0xChat:

1. Generates a random private/public keypair locally.
2. Derives an Ethereum address from it.
3. Stores the identity in that browser profile's `localStorage`.
4. Registers the public key with the 0xChat server.
5. Opens an authenticated session.

There is no onboarding form. The address shown in the header is now your 0xChat identity.

The green **Live** indicator means the app has a real-time connection to the server. If that connection drops, the app shows a warning and reconnects automatically.

### 2. Share your identity

Use the controls beside your address to:

- copy your address;
- copy a direct conversation link; or
- display a QR code containing that link.

A direct link has this form:

```text
https://your-0xchat-host/chat/0x...
```

The other person must have opened the same 0xChat deployment at least once so its server knows their public key.

### 3. Start a conversation

Select **+** above the conversation list, then either:

- paste a full `0x` address and select **Start**; or
- open the QR scanner and scan another user's code.

0xChat checks that the address is valid and registered before opening the conversation. It has no public directory or contact discovery.

### 4. Send a message

Choose an expiry time, type a message, and press **Send**. On a keyboard, **Enter** sends and **Shift+Enter** adds a line break.

Available expiry times are:

- 5, 10, or 30 seconds;
- 1, 5, or 30 minutes; or
- 1, 6, or 24 hours.

The selected time applies to that message. The server rejects unsupported values.

To send an image, use the attachment button, paste an image from the clipboard, or choose an image file. Images are converted to data URLs and encrypted like text. Large images may exceed the server's message-size limit; 0xChat does not resize them.

### 5. Manage conversations

The sidebar shows active conversations, unread markers, and the latest activity time. You can:

- select the pencil to give an address a local label;
- select delete twice within three seconds to hide a conversation; and
- reopen a hidden conversation by starting it again or receiving newer activity.

Labels, known contacts, deletions, and read state are stored only in the current browser. Hiding a conversation does not delete messages from the server or from the other participant's browser. Expired messages disappear automatically, but remembered contacts remain dimmed so you can contact them again.

### 6. Enable notifications

Open **Settings → Notifications** and select **Enable notifications**. Permission is requested only after this explicit action.

Notifications are intentionally generic: the push provider receives no message text, sender, recipient, message ID, or conversation hint. A notification only says **0xChat — New message**, and opening it takes you to the conversation list rather than a specific thread.

Live delivery still uses the app's real-time connection. Push is only an offline wake-up signal and can be delayed or dropped by the browser, operating system, or push provider. If permission was denied, re-enable it in browser or OS settings.

### 7. Install the app

0xChat is an installable Progressive Web App.

- On Chromium-based browsers, use the in-app install banner or the browser's install action.
- On iPhone/iPad, open the site in Safari, use **Share**, then **Add to Home Screen**.

Installation gives 0xChat a home-screen icon and standalone window. The app shell can load offline, but sending, receiving, authentication, and conversation history still require the server. API responses, ciphertext, session tokens, and live-event traffic are never stored in the service-worker cache.

On iOS/iPadOS, Web Push is available to Home Screen apps. The host must use HTTPS in production; localhost is accepted for development.


## Identity and account safety

### Your burner identity

The generated address is controlled by a 32-byte secp256k1 private key. The key stays in browser `localStorage` unless you copy/export it. 0xChat does not use MetaMask or another external wallet.

Browser storage is not a durable backup. Clearing site data, using private browsing, changing browser profiles, or losing the device can destroy the identity.

### Back up an identity

Open **Settings → Export Private Key**, reveal the key, and store it securely. Anyone with this value can become that identity and read messages still available to it.

Treat the exported key like a password that cannot be reset:

- never post it or send it in chat;
- do not store it in screenshots or unencrypted notes;
- do not import a valuable mainnet wallet into 0xChat; and
- verify that the backup is complete before clearing browser data.

### Restore or move an identity

Open **Settings → Import Private Key**, enter the 64-hex-character key (with or without `0x`), review the derived address, then confirm the import.

Importing replaces the current local burner identity. Before switching, the app removes the old push subscription and session, then registers/authenticates the imported identity. Export the current key first if you may need it again.

Using the same private key on multiple devices gives those devices the same address. Push subscriptions are maintained per browser/device.

### Log out and delete the account

Select the logout icon twice within three seconds. 0xChat attempts to remove the current address, sessions, conversations, and push subscriptions from the server, clears the local identity, and immediately creates a new burner identity.

If server cleanup fails, the app still logs out locally and reports the failure. Other participants may retain local contact labels or already-decrypted content. Account deletion cannot erase copies, screenshots, or exports held elsewhere.


## How privacy works

### End-to-end encryption

Each outgoing message is encrypted twice in the browser:

- one copy for the recipient; and
- one copy for the sender, so the sender can reopen it while it exists.

The app uses ECIES: ephemeral ECDH, HKDF-SHA-256, and AES-GCM-256. Canonical message metadata is authenticated as AES-GCM additional data. The complete envelope is also signed with EIP-191, allowing the server and clients to reject tampered, forged, replayed, or mismatched messages.

The server stores encrypted envelopes, not plaintext, and never receives private keys. Clients validate fetched public keys and message envelopes before decrypting them.

### Ephemeral messages

The server records each message with its selected expiry time and removes expired rows during cleanup every 30 seconds. Clients also hide messages on local timers or refresh.

Expiry limits retention by 0xChat; it cannot prevent a recipient from copying plaintext, saving an image, taking a screenshot, modifying their client, or recording the screen. Do not treat self-destruction as control over a recipient's device.

### What the server can still observe

End-to-end encryption protects message content, not all metadata. The server necessarily handles registered public keys, participant addresses, encrypted message size, timestamps, expiry, sessions, IP/network requests, and optional push subscription endpoints. Hosting and reverse-proxy logs may expose additional connection metadata depending on deployment configuration.

### Browser-local information

Your private key, contact labels, remembered contacts, hidden-contact markers, unread state, install-banner preference, and address-bound session token are stored in the current browser. The service worker caches only the application shell and icons; `/api/*` is excluded.


## Troubleshooting

### “Address not registered yet”

The recipient must open this same 0xChat deployment first. Addresses registered on another deployment are not automatically known here.

### Identity disappeared or changed

Check whether site data was cleared, private browsing was used, or a different browser profile is open. Restore the old private key through **Settings → Import Private Key**. There is no recovery process without that key.

### Notifications do not arrive

Confirm that:

- notifications are enabled in 0xChat and in browser/OS settings;
- the app is installed to the Home Screen on iOS/iPadOS;
- the deployment configured valid VAPID keys; and
- the message has not already expired.

Push is best-effort. Open 0xChat directly to reconnect and fetch messages that still exist.

### Camera scanning fails

Grant camera permission, use HTTPS (or localhost during development), and make sure the QR code contains either a raw Ethereum address or an 0xChat `/chat/<address>` link. You can always paste the address manually.

### An old contact remains after messages expire

This is intentional. Contacts are remembered locally after server messages expire. Delete the conversation twice to hide it.

