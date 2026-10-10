# Notifications

0xChat can wake your device when a new message arrives, even when the app is closed.

## Turn them on

Open **Settings → Notifications** and switch on **Notify me of new messages**, then allow
notifications when your browser asks. This is a per-browser choice: turn it on separately on each
device.

On iPhone and iPad, notifications only work once 0xChat is [installed](./install.md) to your home
screen.

## What a notification contains

Nothing about the message. A notification only says that something new arrived; the message
itself is fetched and decrypted when you open the app.

You get one alert per message, and only when you don't have 0xChat open and focused somewhere.
If your device is offline, the alert can wait for up to 24 hours, the same time an unopened
message is kept.

## Troubleshooting

- **The switch is missing and the app says notifications are blocked.** You declined the
  permission earlier. Open the site's settings in your browser (usually the icon beside the
  address bar), allow Notifications, then reload.
- **Notifications stopped arriving.** Turn the switch off and on again. This re-registers your
  browser with the push service.
- **No Notifications section at all.** Your browser does not support web push.
- **You switched identity.** Notifications belong to the identity that enabled them. Turn them on
  again for the new identity.
