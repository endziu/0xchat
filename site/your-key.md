# Your key

Your private key **is** your account. Whoever has it can read your messages and send as you, and
without it you can never use that identity again. There is no password reset and no recovery.

## Back up your key

Open **Settings → Backup → Export private key**, reveal or copy the key and store it somewhere
safe, such as a password manager.

Back up before:

- clearing site data or browser history;
- using a private/incognito window (its storage is wiped when it closes);
- uninstalling the app or switching browsers.

::: danger Never use a valuable wallet key
0xChat keeps your key in browser storage. Treat it as a burner. Do not import a key from a wallet
that holds funds, NFTs or anything else of value.
:::

## Import a key

Paste a key into **Settings → Backup → Import private key**. 0xChat shows the address it belongs
to; click **Import**, then **Confirm import**.

Importing **replaces** the identity in this browser. Export the current key first if you want to
keep it. Messages for an identity stay on the server until they expire, so importing a key back
later shows whatever has not expired yet.

## Use the same identity on several devices

Import the same key on each device. Messages arrive on all of them, and once a message is opened
on one device its deadline applies everywhere. Notifications are enabled separately on each
browser.

## Burn your identity

**Settings → Danger zone → Burn identity…** permanently deletes your identity from this browser,
removes your registration from the server and deletes your messages. It cannot be undone.

If you kept a backup and import that key again later, you get the same address back, but none of
the deleted messages.

## Inactive identities

The server forgets a registration after **30 days** with no activity (no new session and no
messages sent or received). Until you open the app again, people cannot message you and see
*Recipient not registered*. Opening the app with your key registers you again.
