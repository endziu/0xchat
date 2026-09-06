# Cross-browser / mobile push capability matrix

Date: 2026-09-06
Part of #65 / resolves #67

What each popular browser/OS actually supports for background and foreground web notifications, so #68 (iterate vs rebuild) knows the real ceiling for "works on all popular browsers / mobile". Every factual claim cites the source that owns it (vendor docs, release notes, bug trackers, specs); MDN's browser-compat-data (BCD) is used only for version tables. Items that could not be traced to a primary source are marked **unverified**. All sources were accessed on 2026-09-06; the date each source carries is in the Sources list. The repo at `main` (`adf3f52`) is cited inline as `path:line` for what 0xChat does today.

## Summary: what "works everywhere" honestly means

1. **Web Push with VAPID is available on every platform in scope, but with one install gate and two broken browsers.** iOS/iPadOS only deliver push to web apps added to the Home Screen (never to a Safari tab) [WK-13878, BCD]. Edge on Android has returned a placeholder endpoint (`https://permanently-removed.invalid/…`) since roughly autumn 2025 and does not deliver push at all [MS-QA-5686199, MS-QA-5781524]. Brave desktop ships with push transport off ("Use Google services for push messaging", default off) and `subscribe()` never resolves until the user flips it [BRAVE-2362, BRAVE-2143]. Distro Chromium builds pointed at Google's staging GCM endpoint are a fourth, smaller case already handled by #44.
2. **The lowest common denominator notification is: title, body, icon, tag, click-to-focus.** Everything else is per-platform: `image`, `badge`, `vibrate`, `renotify`, `timestamp` are Chromium-only; `actions` are Chromium plus Firefox 152+ (June 2026) and never Safari; `requireInteraction` is Chromium plus Firefox-on-Windows; there is no `sound` member in the Notifications standard at all [BCD, WHATWG-NOTIF]. 0xChat already lives at the common denominator (`public/sw.js:70-78`).
3. **Silent push does not exist on Chrome/Edge/Safari and is quota-limited on Firefox.** Chrome and Edge substitute a generic "site updated in the background" notification when the worker shows nothing [CHROMIUM-PMNM, EDGE-PUSH]; Safari revokes the subscription (three strikes in the Ventura beta) [WWDC22, APPLE-WEBPUSH]; Firefox allows 16 background pushes per origin without a visible notification, then drops the subscription server-side [BUGZ-1375683]. Every platform therefore forces the "always show a notification" design 0xChat already has, and it means content-free pushes cannot be turned into silent app wake-ups anywhere.
4. **Permission must come from a click on every platform**: Safari (macOS and iOS) require direct user interaction [WK-12945, WK-13878, APPLE-WEBPUSH]; Firefox 72+ / Firefox Android 79+ only honour `requestPermission()`/`subscribe()` inside a user gesture [FF-72, BCD]; Chrome does not hard-require a gesture but has run a "quieter" UI since Chrome 80 and, from Chrome 155 (July 2026), a non-blocking Android prompt that can time out without an answer [CRUX-2020, CHROME-155-PROMPT].
5. **The iOS gap is now narrow and stable**: Home Screen install is still mandatory (no change in iOS 26 or the Safari 27 beta, June 2026) [SAFARI-26, WK-17967]; iOS 26 makes every Home-Screen-added site a web app by default, which removes the manifest `display` trap but not the install step [WK-16993, SAFARI-26]; Declarative Web Push (iOS 18.4, macOS 15.5) is an additive option, not a new capability [WK-16535, SAFARI-18.4, SAFARI-18.5]. The only route to push without the install step is a native wrapper (Capacitor → APNs) with App Store review guideline 4.2 risk [CAPACITOR, ASRG].

## 1. Availability matrix

Web Push (VAPID) availability, whether installation is required, permission model, and the push-service host the browser hands back (this is what 0xChat's allowlist in `src/server/validation.ts:27-32` must accept).

| Platform / browser | Web Push (VAPID) | Install required? | Permission model | Push-service host | Notes |
|---|---|---|---|---|---|
| Desktop Chrome (Win/macOS/Linux) | Yes, since Chrome 42 (2015); VAPID since 52 [CHROME-42, CS-GCM-DEPR] | No | Prompt; quieter UI auto-enrols low-accept sites (Chrome 80) [CRUX-2020]; auto-revoke for low-engagement/high-volume sites since Oct 2025, installed web apps exempt [GOOGLE-AUTOREVOKE] | `fcm.googleapis.com` (allowlisted) | Chrome must be running to receive pushes on desktop [CHROME-42]. Chrome 59+ on macOS uses native notifications: `image` ignored, action icons dropped [CHROME-MAC]. Distro Chromium may return the staging host `jmt17.google.com` and log `DEPRECATED_ENDPOINT` → #44. |
| Desktop Brave | Chromium code path, but transport is **off by default**: "Use Google services for push messaging" [BRAVE-2362] | No | As Chrome, plus the transport toggle | When enabled: routed through a Brave proxy to Google's push service [BRAVE-2362]; returned host **unverified** (no capture yet; #44 acceptance still open) | With the toggle off `pushManager.subscribe()` hangs pending [BRAVE-2143]. Brave staff: "it will send a payload to the Google endpoint … which is why it's disabled by default" (2021) [BRAVE-2362]. Brave Android used FCM in 2019 and staff said it "will stop supporting it in the future" [BRAVE-2143]; current Android state **unverified**. |
| Desktop Edge (Windows) | Yes, Edge 17+ (EdgeHTML, Windows 10 April 2018 Update); Chromium Edge continues [EDGE-2018, BCD] | No | Prompt; `userVisibleOnly: true` mandatory ("Microsoft Edge doesn't support push messages that aren't displayed to the user") [EDGE-PUSH] | Windows Push Notification Service; Edge uses the Windows OS WNS client by default (built-in client via policy, Edge ≥118) [EDGE-POLICY]; channel URIs are on `notify.windows.com` [WNS] | Allowlist entry `notify.windows.com` + subdomains covers this. Edge on macOS/Linux: which push service is used is **unverified**. |
| Desktop Firefox | Yes, Firefox 44+ [BCD] | No | `requestPermission()` and `subscribe()` only inside a user gesture since Firefox 72 (Jan 2020) [FF-72, BCD] | Mozilla autopush, `updates.push.services.mozilla.com` (allowlisted); Mozilla "runs their own push service" [BRAVE-2143 (diracdeltas)] | Per-origin background-push quota (see §4). Whether Firefox must be running to receive pushes on desktop: **unverified** (Mozilla support article not retrievable). |
| Desktop Safari (macOS) | Yes, Safari 16 on macOS 13 Ventura [WK-12945, APPLE-WEBPUSH] | No (browser tab is fine); also works in web apps on Mac | Subscription "requires an explicit user gesture" (mouse click or keystroke); `userVisibleOnly` must be true [WK-12945, WWDC22] | `*.push.apple.com` — Apple: "allow access for `https://*.push.apple.com`" [APPLE-WEBPUSH]; observed host `web.push.apple.com` (allowlisted) | "Safari doesn't even need to be running for a push message to be delivered" [WK-12945]. Declarative Web Push on macOS 15.5 / Safari 18.5 [SAFARI-18.5]. Payload limit 4 KB [APPLE-WEBPUSH]. |
| Android Chrome | Yes, since Chrome 42, in the browser [CHROME-42] | **No.** Installed web apps differ only in being exempt from auto-revocation [GOOGLE-AUTOREVOKE] | Prompt; per-origin Android notification channel since M62 (user controls sound/vibration/importance per site) [CHROMIUM-CHANNELS]; Chrome 155+ non-blocking prompt that "expires and times out regardless of user action" — sites must watch `navigator.permissions.query()` [CHROME-155-PROMPT] | `fcm.googleapis.com` | Delivery subject to Doze (§4). |
| Android Firefox | Yes, Firefox Android 48+ per BCD; GeckoView push landed in mozilla71 (Sept 2019) for Fenix [BCD, BUGZ-1343678] | No; "Add to Home screen" PWAs exist, and Mozilla noted push notifications "open in the browser, rather than in the PWA" (2019) [FENIX-771] — current behaviour **unverified** | User gesture required since Firefox Android 79 [BCD] | Mozilla autopush | Feature-level support (actions, image, …) is recorded as unknown in BCD; treat as title/body/icon only. |
| Android Samsung Internet | Yes, "Notification API and Push API since v4" [SAMSUNG-PWA] | No — Samsung's PWA docs do not tie push to installation [SAMSUNG-PWA] | Prompt (Chromium-derived) | Google's push service — Chrome's 2015 launch post lists sender-ID setup "for Chrome, Opera for Android, and Samsung Browser" [CHROME-42]; the VAPID-era host is **unverified** (expected `fcm.googleapis.com`; needs a device capture like #44) | Notifications only from a service worker [BCD]. |
| Android Edge | **Broken.** `subscribe()` succeeds with endpoint `https://permanently-removed.invalid/…`; Microsoft moderator (2025-12-30): "Web Push delivery may not function as expected on this platform … Edge on Android can return a placeholder endpoint" [MS-QA-5686199]; users bisected the break to builds after Sept 2025 [MS-QA-5781524] | n/a | n/a | `permanently-removed.invalid` | 0xChat's allowlist rejects it → user sees the #44 "push service not supported" message. Correct outcome by accident; worth a browser-specific hint. |
| iOS / iPadOS Safari | Yes, **only for web apps added to the Home Screen**, since 16.4 (March 2023) [WK-13878, APPLE-WEBPUSH] | **Yes.** In a Safari tab `Notification`/`PushManager` are undefined; before iOS 26 the manifest also needed a non-default `display` [BCD]; iOS 26: "every website added to the Home Screen opens as a web app" by default [WK-16993, SAFARI-26] | Request "in response to direct user interaction — such as tapping on a 'subscribe' button"; call `subscribe` "immediately from the gesture's event handler" [WK-13878, APPLE-WEBPUSH] | `*.push.apple.com` | No silent push (permission revoked) [APPLE-WEBPUSH]. Badging API for Home Screen web apps [WK-13878]. Declarative Web Push iOS 18.4+ (Home Screen web apps only) [WK-16535, WWDC25]. Nothing new in Safari 26.x / 27 beta [SAFARI-26.2, SAFARI-26.4, SAFARI-27B, WK-17967]. |

## 2. Feature matrix

Versions from BCD 8.1.0 (data file last changed 2026-08-19) unless another source is named; "—" = no support; "?" = BCD records no data (treat as unsupported). 0xChat column says what `public/sw.js:70-78` sends today.

| Feature | Chrome desktop | Edge desktop | Firefox desktop | Safari macOS | Chrome Android | Firefox Android | Safari iOS (Home Screen) | 0xChat uses |
|---|---|---|---|---|---|---|---|---|
| `icon` | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes (`/icon-192.png`) |
| `badge` (small mono icon) | 53 (parsed, not shown) | 18 | — | — | Only platform that displays it: "At the time of writing the badge is only used in Chrome on Android" [WEBDEV-DISPLAY] | ? | ? | Yes (`/icon-192.png`, wrong format: should be a monochrome ~96 px mask [MDN-BADGE]) |
| `image` (large picture) | 56, but ignored on macOS native notifications [CHROME-MAC] | 18 | — | — | Yes | ? | ? | No |
| `actions` (buttons) | 53; on macOS only via the "More" hover menu, no icons [CHROME-MAC] | 18 | **152** (16 June 2026): "buttons below the notification text or in the Options list on macOS" [FF-152] | — | Yes; icons not shown on Android 7+ [WEBDEV-DISPLAY] | ? | — | No |
| `silent` (no sound/vibration) | 43 | 17 | 132 | 16.6 | Yes, but Android O+ per-site channel settings govern sound/vibration [CHROMIUM-CHANNELS] | ? | — (BCD: no) | No |
| `vibrate` | 53 | ? | — | — | Yes; "deprecated on Android 8 and later" [WEBDEV-DISPLAY] | ? | ? | No |
| `renotify` | 50 | ? | — | — | Yes | ? | ? | No (same `tag`, so repeats are silent where honoured) |
| `requireInteraction` | 47 | 17 | 117, Windows only (flag elsewhere) | — | n/a by spec ("sufficiently large screen") [WHATWG-NOTIF] | ? | ? | No |
| `tag` (collapse/replace) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes (`0xchat-message`) |
| `timestamp` | 50 | 17 | — | — | Yes | ? | ? | No |
| `data` | 44 | 16 | 34 | 16 | Yes | ? | 16.4 | Yes (`{ url: '/chat' }`) |
| Sound | No `sound` member exists in the Notifications standard [WHATWG-NOTIF]; web.dev: "no browser has support for this option" [WEBDEV-DISPLAY]. OS default sound plays unless `silent`; on Android the per-site channel decides [CHROMIUM-CHANNELS]; iOS plays the platform default (Declarative Web Push demo "request[s] that the platform play the default notification sound") [WWDC25] | | | | | | | n/a |
| Silent push (no notification) | No: generic notification substituted unless a tab for the origin is visible or engagement budget allows [CHROMIUM-PMNM] | No: "generic notification" [EDGE-PUSH] | Quota: 16 background pushes/origin, then subscription dropped [BUGZ-1375683] | No: revoked after 3 in the Ventura beta [WWDC22]; "Safari revokes the push notification permission" [APPLE-WEBPUSH] | As Chrome desktop | As Firefox desktop | No [APPLE-WEBPUSH] | No (always shows) |
| Badging API (`setAppBadge`) | 81 (Win/macOS), 91 ChromeOS, not Linux [BCD] | 81 (Chromium) | — | 17, installed web apps on Sonoma+ [BCD] | — (BCD: no; Android launchers count notifications themselves) | ? | 16.4, Home Screen web apps [WK-13878, BCD] | No |
| `pushsubscriptionchange` | **138** (24 June 2025), only when permission is re-granted after revocation; empty old/new subscription [CHROME-138, CS-PSC-138] | 17–79 then dropped [BCD] | 44, without `oldSubscription`/`newSubscription` [BCD]; not fired on quota expiry until the next visit [BUGZ-1375683] | 16 | 138 | 48 (partial) | — (BCD: no) | Not handled (#66) |
| `expirationTime` | Always `null` ("until we support subscription refreshes") [CS-EXPTIME] | Reported to set 30 days — **unverified** (only seen in W3C issue discussion) | 96 | 16 | null | ? | 16.4 | Not read |

## 3. Constraints and background behaviour per platform

### Chrome / Chromium (desktop and Android)

- **Must show a notification.** `userVisibleOnly: true` is required ("Chrome currently only supports the Push API for subscriptions that will result in user-visible messages") [WEBDEV-SUBSCRIBE]. If the `push` handler's `waitUntil` promise settles without a notification, Chrome shows "This site has been updated in the background." [WEBDEV-HANDLING]. Chromium source: "Sites with a currently visible tab don't need to show notifications" (`IsTabVisible` → `notification_needed = false`), and a site-engagement budget can allow an occasional silent push; otherwise "we will show a generic notification" tagged `kPushMessagingForcedNotificationTag` [CHROMIUM-PMNM].
- **Subscriptions do not expire on a timer**, but Chrome never refreshes them either (`expirationTime` is always null) [CS-EXPTIME]. `pushsubscriptionchange` only fires since Chrome 138 and only on permission re-grant [CHROME-138]; the general refresh/revoke/lost event is still "In development" [CS-PSC-DEV]. Practical consequence: a subscription dies silently when the user revokes permission or Chrome auto-revokes it; the server learns via 404/410 on send.
- **Auto-revocation (Oct 2025).** "Chrome will automatically remove notification permission for sites you haven't interacted with recently", Android and desktop, targeting "very low user engagement and a high volume of notifications"; "does not revoke notifications for any installed web apps"; users are told and can re-grant [GOOGLE-AUTOREVOKE].
- **Sender rate limit (Jan 2026).** Sites "sending a high volume of notifications with very little user engagement" get limited to "no less than 1000 per minute"; above that the push service answers HTTP 429; Notifications API from an open page is unaffected [CHROME-RATELIMIT].
- **GCM/sender-ID subscriptions are being removed** server-side (Chrome 113 flag, 2023): "Users who receive such messages will stop receiving them until they re-visit the sender's website" [CS-FCM-REMOVE]. VAPID is the only supported path [CS-GCM-DEPR]; relevant to the `DEPRECATED_ENDPOINT` log in #44.
- **Desktop needs Chrome running**: "Chrome on desktop has the caveat that if Chrome isn't running, push messages won't be received" [CHROME-42].
- **Android Doze.** Doze "Suspends network access" and wakes only in maintenance windows; "FCM high priority messages let you wake your app … In Doze or App Standby mode, the system delivers the message"; normal priority is deferred to a maintenance window or until the user wakes the device [ANDROID-DOZE]. Web Push carries an `Urgency` header (`very-low|low|normal|high`; RFC 8030 pairs `normal` with "Chat" and `high` with "Low battery") [RFC-8030, WEBDEV-PROTOCOL]. Whether Chrome/FCM maps `Urgency` to FCM priority is **unverified**; a 2017 Chromium thread acknowledged reports that high-priority pushes did not wake Chrome in Doze [CHROMIUM-DOZE]. TTL matters here: a message whose TTL lapses before the next maintenance window is simply dropped by the push service [RFC-8030 §5.2, WEBDEV-PROTOCOL].
- **Android channels.** Since M62 each origin with permission gets its own Android notification channel; the OS-level channel decides sound, vibration, importance and DND override, not the site's `silent`/`vibrate` options [CHROMIUM-CHANNELS].
- **Permission UI.** Quieter UI since Chrome 80 (auto-enrol sites with "very low Accept rates") [CRUX-2020]. Chrome 155+ on Android: prompt is non-blocking, lives in Site Controls, and "expires and times out regardless of user action", so `requestPermission()` may resolve without a decision — listen for `navigator.permissions.query({name:'notifications'})` changes [CHROME-155-PROMPT].

### Brave

- Push transport is behind "Use Google services for push messaging" (`brave://settings/privacy`), "set to OFF by default" [BRAVE-2362]. With it off, `pushManager.subscribe()` stays pending [BRAVE-2143]. Brave's rationale: the payload goes "to the Google endpoint … handled by a 3rd party which is why it's disabled by default" [BRAVE-2362]. When on, requests are proxied by Brave [BRAVE-2362]. The browser gives no in-page signal (Brave staff noted the lack of an infobar) [BRAVE-2143].
- Brave on Android worked over FCM in 2019 while staff said Android "will stop supporting it in the future" [BRAVE-2143]; current Android transport and endpoint host are **unverified** (this is the evidence #44 still asks for).

### Edge

- Desktop Windows: `userVisibleOnly` must be true; missing notification → "generic notification that indicates that a push message was received" [EDGE-PUSH]. Delivery via WNS through the Windows OS client (or Edge's built-in WNS client under `ForceBuiltInPushMessagingClient`, Edge ≥118) [EDGE-POLICY]; channel URIs must be on `notify.windows.com` [WNS]. WNS web-push endpoints have had outages (July 2024) [EDGE-DEVTOOLS-262].
- Android: non-functional since ~Sept/Oct 2025 (placeholder endpoint) [MS-QA-5686199, MS-QA-5781524].

### Firefox (desktop and Android)

- **Quota instead of forced notification**: "We explicitly chose to throttle push notifications instead of the 'must show a notification' approach chrome chose" [BUGZ-1437919]. "Each origin has a limited number of background pushes, capped at 16, and based on the visit time … the more recent your last visit, the higher the quota." A 3-second timer after each push checks for a visible notification and docks the quota if none. When exhausted "we 'expire' the subscription, where we drop it on the server, but prevent the page from resubscribing (and don't fire the `pushsubscriptionchange` event) until after the next time you visit the page" [BUGZ-1375683]. The quota "is also not enforced if you have the page open" [BUGZ-1437919].
- **Gesture-bound permission** since Firefox 72 ("a speech bubble will appear in the address bar when you interact with the site") [FF-72]; BCD: `requestPermission()`/`subscribe()` "can only be called in response to a user gesture" (72 desktop, 79 Android) [BCD].
- Notification actions arrived in Firefox 152 (June 2026) [FF-152]; `silent` in 132; `requireInteraction` Windows-only [BCD]. No Badging API.
- Android: GeckoView push since mozilla71 [BUGZ-1343678]. Push delivered "whether or not Fenix is in the foreground or currently loaded" [FENIX-771].

### Safari macOS

- Gesture-bound subscribe ("a mouse click or a keystroke") [WWDC22]; `userVisibleOnly` required; "Violations of the `userVisibleOnly` promise will result in a push subscription being revoked" [WK-12945]; the beta threshold was three missed notifications [WWDC22]. Apple's current doc phrases it as "Safari revokes the push notification permission for your site" [APPLE-WEBPUSH].
- Runs through the macOS push system: delivery does not need Safari running [WK-12945]. Supports `TTL`, `Urgency`, `Topic` (≤32 chars); payload ≤4 KB (`PayloadTooLarge`) [APPLE-WEBPUSH].
- No `actions`, `image`, `badge`, `vibrate`, `renotify`, `requireInteraction`; `silent` from 16.6 [BCD]. Badging for installed web apps on Sonoma (Safari 17) [BCD].
- Declarative Web Push from Safari 18.5 / macOS 15.5 [SAFARI-18.5] (details in §6).

### iOS / iPadOS

- Home Screen web apps only; permission on direct interaction; "notifications from web apps work exactly like notifications from other apps. They show on the Lock Screen, in Notification Center, and on a paired Apple Watch"; Focus integration; Badging API [WK-13878].
- "Safari doesn't support invisible push notifications. Present push notifications to the user immediately after your service worker receives them. If you don't, Safari revokes the push notification permission for your site." [APPLE-WEBPUSH].
- `pushsubscriptionchange` and `notificationclick` are recorded as unsupported on iOS in BCD [BCD] — the `notificationclick` entry contradicts Apple's "when the user activates that notification, the service worker is sent an event" [WK-12945] and should be treated as a BCD data gap; **unverified** on device.
- Background execution of the web app itself (SSE/WebSocket staying alive while backgrounded) is not documented by Apple for Home Screen web apps; assume none (**unverified**, inferred from the push design).

## 4. Foreground behaviour: push arrives while the app is open

**What the platforms do.** The Push API delivers "even if that web application is not currently active in a browser window" [PUSH-API], so the `push` event fires in the service worker regardless of open tabs on every platform; nothing in scope suppresses it. What differs is whether the worker may then *skip* the notification:

| Platform | Skipping `showNotification` when a window is visible |
|---|---|
| Chrome / Chromium (incl. Brave, Samsung, Chrome Android) | Allowed: "Sites with a currently visible tab don't need to show notifications" [CHROMIUM-PMNM]. web.dev's canonical pattern is `clients.matchAll({type:'window', includeUncontrolled:true})` → any `windowClient.focused` → `postMessage` to the page instead of notifying [WEBDEV-PATTERNS]. |
| Edge desktop | Not documented; Chromium code path, so expected to match Chrome — **unverified**. |
| Firefox | Allowed and cheap: the quota "is also not enforced if you have the page open" [BUGZ-1437919]. |
| Safari macOS / iOS | **Not safe.** Apple: present the notification "immediately after your service worker receives them" or the permission is revoked [APPLE-WEBPUSH]; no visible-window exemption is documented. |

**Recommended pattern** (what the vendors themselves publish):

1. In `push`: `event.waitUntil(...)` around the whole chain (Chrome keeps the worker alive only that long, and the notification must be shown before the promise settles) [WEBDEV-HANDLING].
2. `clients.matchAll({ type: 'window', includeUncontrolled: true })`, look at `focused` (web.dev) and/or `visibilityState === 'visible'`; `postMessage` to those clients so the page can refresh in place [WEBDEV-PATTERNS].
3. Decide per platform: on Chromium/Firefox skip the notification when a client is focused; on Safari always show it (or dedupe by `tag`, which replaces rather than adds).
4. In `notificationclick`: `event.notification.close()`, then `matchAll` → `focus()` an existing client whose URL matches, else `clients.openWindow(url)` ("we should focus a window rather than open a new window every time") [WEBDEV-PATTERNS]. 0xChat does this except it focuses the first client regardless of URL (`public/sw.js:82-93`).

## 5. The iOS gap

**What is missing today (iOS 26.x / Safari 26.4, Sept 2026):**

- Push only reaches Home Screen web apps; a Safari tab has no `Notification`/`PushManager` at all [WK-13878, BCD]. Unchanged through Safari 26.4 and the Safari 27 beta [SAFARI-26.2, SAFARI-26.4, SAFARI-27B, WK-17967].
- No silent/background push; every push must produce a notification or the permission is revoked [APPLE-WEBPUSH].
- No `actions`, `image`, `badge` (notification), `silent` (BCD: no on iOS), `renotify`, `requireInteraction`, `vibrate` [BCD]. Available: title, body, icon, tag, data, Badging API [WK-13878, BCD].
- No user-agent refresh signal on iOS (`pushsubscriptionchange`: no in BCD) [BCD].
- Payload ≤4 KB [APPLE-WEBPUSH] (irrelevant to a payload-less design).

**What narrowed the gap:**

- iOS 16.4 (March 2023): Web Push + Badging for Home Screen web apps [WK-13878].
- iOS 18.4 (March 2025): Declarative Web Push — the push body is JSON (`web_push: 8030`, `notification: { title, body, navigate, app_badge?, lang?, dir?, silent? }`), displayed by the OS without running a service worker; `window.pushManager` for subscription management; optional `mutable: true` lets a worker replace the text (and if it "fails to decrypt the message and therefore fails to offer a replacement, the original plain text notification will be used instead") [WK-16535, WWDC25]. Still Home Screen only on iOS ("web apps saved to the home screen on iOS 18.4 and iPadOS 18.4 and later") [WWDC25]. Mozilla's standards position is positive [MOZ-SP-1176]; no Chrome status entry exists [CHROMESTATUS-SEARCH].
- iOS 26 (Sept 2025): "every website added to the Home Screen opens as a web app" by default, user-togglable [WK-16993, SAFARI-26]. The manifest `display` requirement for push therefore stops being a trap on iOS 26, but the user must still add the site to the Home Screen.

**The EU / DMA episode (Feb–Mar 2024).** In the iOS 17.4 betas Apple removed Home Screen web apps in the EU, citing "complex security and privacy concerns associated with web apps" under alternative browser engines; on 2024-03-01 Apple reversed: "we will continue to offer the existing Home Screen web apps capability in the EU", built "directly on WebKit" [9TO5MAC-2024, secondary — Apple's DMA support page no longer carries the text and the archive could not be fetched]. Relevance: the Home Screen dependency is a single point of policy failure that Apple has once been willing to pull.

**Alternatives to the web-only path:**

- Native wrapper: Capacitor's push plugin uses "Apple Push Notification service (APNs) on iOS and Firebase Cloud Messaging (FCM) on Android"; requires the Push Notifications capability and APNs credentials on iOS and `google-services.json` on Android [CAPACITOR]. That gives background push without Home Screen install but moves 0xChat into App Store review, where guideline 4.2 rejects apps that do not "elevate it beyond a repackaged website" and 4.2.2 excludes "web clippings" [ASRG]; 4.7 permits embedded HTML5 content only inside an app that is itself acceptable [ASRG]. It also replaces the burner-identity/VAPID binding with APNs device tokens (a different privacy surface).
- Declarative Web Push: reduces device-side cost and works without a registered worker, but it does not lift the install requirement and it requires a *payload* (title/body/navigate) — encrypted per RFC 8291 in transit, so the push service still learns nothing, but the notification text is chosen server-side.
- Roadmap: nothing announced at WWDC24, WWDC25 or WWDC26 changes the Home Screen requirement [SAFARI-18, WK-16993, WK-17967]; the only web-app items in Safari 26–27 are "any website can become a web app" and Service Worker static routing [SAFARI-26, WK-17967].

## 6. Timeline of changes, 2023–2026

| Date | Change | Source |
|---|---|---|
| 2023-02-16 | iOS/iPadOS 16.4: Web Push + Badging for Home Screen web apps; permission on direct interaction | [WK-13878] |
| 2023-04 | Chrome 113 flag: remove delivery to FCM sender-ID (non-VAPID) subscriptions; rollout server-side | [CS-FCM-REMOVE] |
| 2023-09-11 | WebKit publishes the Declarative Web Push proposal | [W3C-PUSH-360] |
| 2024-02 → 03-01 | Apple removes then restores Home Screen web apps in the EU for iOS 17.4 | [9TO5MAC-2024] (secondary) |
| 2024-07 | WNS web-push endpoints (`*.notify.windows.com`) outage reported | [EDGE-DEVTOOLS-262] |
| 2025-02-12 | Mozilla standards position on Declarative Web Push: positive | [MOZ-SP-1176] |
| 2025-03-27 | Safari 18.4 / iOS 18.4: Declarative Web Push (Home Screen web apps) | [WK-16535, SAFARI-18.4] |
| 2025-05 | Safari 18.5 / macOS 15.5: Declarative Web Push on macOS | [SAFARI-18.5] |
| 2025-06-09 | WWDC25: iOS 26 opens any Home-Screen-added site as a web app by default | [WK-16993] |
| 2025-06-24 | Chrome 138: `pushsubscriptionchange` on permission re-grant | [CHROME-138] |
| 2025-09 (est.) | Edge for Android starts returning `permanently-removed.invalid` endpoints | [MS-QA-5781524] |
| 2025-09 | Safari 26: "any website to become a web app on iOS or iPadOS" | [SAFARI-26] |
| 2025-10-10 | Chrome auto-revokes notification permission for low-engagement/high-volume sites (Android + desktop); installed web apps exempt | [GOOGLE-AUTOREVOKE] |
| 2025-12-01 | W3C Push API Working Draft update (expirationTime / pushsubscriptionchange wording used here) | [PUSH-API] |
| 2025-12-30 | Microsoft moderator confirms Edge Android push does not deliver | [MS-QA-5686199] |
| 2026-01-06 | Chrome: 429 rate limit (≥1000/min) for low-engagement senders | [CHROME-RATELIMIT] |
| 2026-03-15 | WHATWG Notifications standard revision used here | [WHATWG-NOTIF] |
| 2026-04-27 | W3C Badging API Working Draft revision used here | [BADGING] |
| 2026-06-08 | WWDC26 / Safari 27 beta: no push/web-app changes; Service Worker static routing | [WK-17967, SAFARI-27B] |
| 2026-06-16 | Firefox 152: notification `actions` | [FF-152] |
| 2026-07-22 | Chrome 155: lighter Android prompt; prompts time out; watch permission changes | [CHROME-155-PROMPT] |

## 7. Implications for 0xChat

What 0xChat does today: server sends a payload-less push with `TTL` = message lifetime and no `Urgency`/`Topic` (`src/server/push.ts:13-30`); the worker always shows a fixed "0xChat / New message" with `icon`, `badge` (same PNG), `tag`, `data.url` (`public/sw.js:68-80`); click focuses the first window client or opens `/chat` (`:82-93`); subscribe is gesture-initiated but the prompt runs inside a serial queue (`src/client/hooks/usePushSubscription.ts:62-79`); endpoint hosts are allowlisted to FCM, Mozilla, Apple and WNS (`src/server/validation.ts:27-32`); the UI is hidden when `PushManager`/`Notification` are absent (`usePushSubscription.ts:29`).

Mapping the #66 gaps and the platform findings onto ceiling vs fixable:

| Item | Ceiling or fixable | Why |
|---|---|---|
| iOS needs Home Screen install and a gesture | **Ceiling** (Apple) | [WK-13878, APPLE-WEBPUSH]. Fixable part: instead of hiding the button when `PushManager` is absent, detect iOS-not-standalone (`display-mode` media query / `navigator.standalone`) and show an "Add to Home Screen to enable notifications" hint. iOS 26 removes the manifest `display` footgun but not the step. |
| Brave desktop cannot subscribe until the user flips a setting | **Ceiling** (Brave) | [BRAVE-2362, BRAVE-2143]. Fixable part: time-box `subscribe()` (it hangs rather than rejecting) and show Brave-specific guidance; capture the endpoint host once to close #44's Brave item. |
| Edge Android delivers nothing | **Ceiling** (Microsoft, current builds) | [MS-QA-5686199]. The allowlist already yields the "unsupported push service" message; a browser-specific wording is optional. |
| Distro Chromium staging endpoint | **Ceiling** (#44) | [CS-FCM-REMOVE] adds vendor context: non-VAPID/GCM paths are being removed server-side. |
| Push fires while the tab is open (double notify) | **Fixable on Chromium/Firefox, ceiling on Safari** | Chromium exempts visible tabs [CHROMIUM-PMNM]; Firefox does not count open-page pushes [BUGZ-1437919]; Safari revokes on missing notifications [APPLE-WEBPUSH]. So the SW-side focus check from #66 is safe everywhere *except* Safari, where suppression must happen server-side (skip `pushNotify` when an SSE client for the recipient is connected) or be replaced by `tag` dedupe. This is the one #66 question the matrix changes: the answer is platform-split, not either/or. |
| No `pushsubscriptionchange` handler | **Mostly ceiling** | Chrome fires it only on re-grant (138+) and never refreshes [CHROME-138, CS-EXPTIME]; Firefox withholds it after quota expiry until the next visit [BUGZ-1375683]; iOS: no [BCD]. The existing session-start re-upload (`src/client/lib/push-reupload.ts`) is the load-bearing recovery on every platform; adding the handler is cheap insurance for Chrome re-grant and Safari macOS only. |
| VAPID rotation → `InvalidStateError` | **Fixable** | Spec behaviour, uniform across platforms [PUSH-API]. |
| TTL = message lifetime vs 24 h retention | **Policy, with a platform edge** | A 5 s TTL cannot survive Android Doze maintenance windows [ANDROID-DOZE, RFC-8030]; Apple honours TTL/Urgency/Topic [APPLE-WEBPUSH]. Whether to send `Urgency: high` for short-lived messages is a product decision; Chrome's Urgency→priority mapping is unverified. |
| Content-free payload | **Compatible everywhere**; blocks two optional features | It forbids deep-linking on click and unread counts; the Badging API is available on iOS Home Screen, Safari 17 installed apps, Chrome/Edge desktop but not Chrome Android or Firefox [BCD], and the worker could count wake-ups locally without a payload. Declarative Web Push would require a payload (title/body/navigate) [WK-16535] — a fixed "New message" body would preserve the content-free property toward the push service (RFC 8291 encryption) but not toward the device. |
| Notification `badge` set to the colour icon | **Fixable** | Only Chrome Android displays it, and it expects a ~96 px monochrome mask [MDN-BADGE, WEBDEV-DISPLAY]. |
| Permission prompt inside the queue | **Fixable, and more urgent** | Firefox and Safari hard-require the gesture [FF-72, WWDC22]; Chrome 155's timing-out prompt means `requestPermission()` can return `default` with no decision — 0xChat should also subscribe to `permissions.query` changes [CHROME-155-PROMPT]. |
| Chrome auto-revocation | **Mitigable** | Applies to low-engagement, high-volume origins; installed web apps are exempt [GOOGLE-AUTOREVOKE]. A chat that fires one collapsed notification per message is the shape it targets if the user never clicks; nudging install on Android is the lever, plus the Chrome 138 re-grant event + re-upload for recovery. |
| Chrome 429 sender limit | **Not a concern** | 0xChat's message caps (120/min per ip+address) are far below 1000/min [CHROME-RATELIMIT, README]. |
| Firefox quota | **Not a concern while every push shows a notification** | Quota is docked only when no notification is visible 3 s after the push [BUGZ-1375683]; the `tag` replacement still counts as visible. |
| Feature parity (actions, images, sounds) | **Ceiling** | The intersection is title/body/icon/tag; anything richer is Chromium-only or Chromium+Firefox 152 [BCD, FF-152]. 0xChat uses nothing outside the intersection except `badge`. |

Net: the current split (SSE foreground, payload-less Web Push background, always-show worker) is already the design the platform rules force. The ceilings are all outside the codebase (iOS install step, Brave's default, Edge Android, distro Chromium); the fixable items are the ones #66 listed, with one platform-specific correction (Safari cannot use an SW-side suppression).

## What could not be verified

- Brave's returned endpoint host when "Use Google services for push messaging" is on, and Brave Android's current transport (staff statements are from 2019–2021).
- Which push service Edge uses on macOS/Linux; whether Edge sets `expirationTime` (30 days) — seen only in W3C issue chatter.
- Samsung Internet's VAPID-era endpoint host (Chrome's 2015 post ties it to Google's service).
- Whether Chrome/FCM maps the Web Push `Urgency` header to FCM high priority for Doze.
- Whether Firefox desktop must be running to receive pushes (Mozilla support article blocked the fetch).
- iOS: behaviour of a push arriving while the Home Screen web app is foregrounded; background execution limits for web apps; `notificationclick` support (BCD says no, Apple's blog implies yes).
- Apple's original EU statement text: only reproduced by press; Apple's page has since been rewritten and web.archive.org is not reachable from this environment.
- Firefox for Android: whether push notifications still open in the browser rather than the installed PWA (2019 statement).

## Sources

Repository files are cited inline as `path:line` against `main` at `adf3f52`. Issues: #44, #65, #66, #67, #68 in `endziu/0xchat`. All accessed 2026-09-06.

Specs and RFCs:

- [PUSH-API] W3C Push API, Working Draft 1 December 2025 — `userVisibleOnly`, `expirationTime`, `pushsubscriptionchange`, delivery while inactive. https://www.w3.org/TR/push-api/
- [WHATWG-NOTIF] WHATWG Notifications API Standard, 15 March 2026 — `NotificationOptions` members, `silent`, `renotify`, `requireInteraction`, actions/`maxActions`, feature-ignoring note. https://notifications.spec.whatwg.org/
- [BADGING] W3C Badging API, Working Draft 27 April 2026 — installed-app scope, badge placement. https://www.w3.org/TR/badging/
- [RFC-8030] RFC 8030 §5.2 TTL, §5.3 Urgency, §7.3 expiration/404. https://www.rfc-editor.org/rfc/rfc8030

Apple / WebKit:

- [WK-12945] WebKit, "Meet Web Push for Safari", 7 June 2022. https://webkit.org/blog/12945/meet-web-push/
- [WWDC22] Apple WWDC22 session 10098 "Meet Web Push for Safari" — three missed notifications revoke (Ventura beta), click/keystroke gesture, `*.push.apple.com`. https://developer.apple.com/videos/play/wwdc2022/10098/
- [WK-13878] WebKit, "Web Push for Web Apps on iOS and iPadOS", 16 February 2023. https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- [APPLE-WEBPUSH] Apple Developer, "Sending web push notifications in web apps and browsers" (UserNotifications) — platform requirements, gesture, invisible pushes revoke, headers, 4 KB limit. https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- [WK-16535] WebKit, "Meet Declarative Web Push", 27 March 2025. https://webkit.org/blog/16535/meet-declarative-web-push/
- [WWDC25] Apple WWDC25 session 235 "Learn more about Declarative Web Push" — Safari 18.5 macOS, Home Screen web apps iOS 18.4, `app_badge`, `mutable`. https://developer.apple.com/videos/play/wwdc2025/235/
- [SAFARI-17.4] Safari 17.4 release notes (no push items). https://developer.apple.com/documentation/safari-release-notes/safari-17_4-release-notes
- [SAFARI-18] Safari 18 release notes (no push items). https://developer.apple.com/documentation/safari-release-notes/safari-18-release-notes
- [SAFARI-18.4] Safari 18.4 release notes — "Added support for Declarative Web Push." iOS 18.4 / macOS 15.4. https://developer.apple.com/documentation/safari-release-notes/safari-18_4-release-notes
- [SAFARI-18.5] Safari 18.5 release notes — "Added support for Declarative Web Push on macOS." https://developer.apple.com/documentation/safari-release-notes/safari-18_5-release-notes
- [WK-16993] WebKit, "News from WWDC25: WebKit in Safari 26 beta", 9 June 2025 — every Home-Screen site opens as a web app. https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/
- [SAFARI-26] Safari 26 release notes — "Added support for any website to become a web app on iOS or iPadOS." https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes
- [SAFARI-26.2] Safari 26.2 release notes (no push items). https://developer.apple.com/documentation/safari-release-notes/safari-26_2-release-notes
- [SAFARI-26.4] Safari 26.4 release notes (no push items). https://developer.apple.com/documentation/safari-release-notes/safari-26_4-release-notes
- [SAFARI-27B] Safari 27 beta release notes (no push items). https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes
- [WK-17967] WebKit, "News from WWDC26: WebKit in Safari 27 beta", 8 June 2026 — Service Worker static routing; nothing on push. https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/
- [ASRG] App Store Review Guidelines §4.2, 4.2.2, 4.7. https://developer.apple.com/app-store/review/guidelines/
- [9TO5MAC-2024] 9to5Mac, 1 March 2024, reproducing Apple's EU statement (secondary; Apple's DMA page no longer carries it). https://9to5mac.com/2024/03/01/apple-home-screen-web-apps-ios-17-eu/

Google / Chromium:

- [CHROME-42] Chrome for Developers, "Push Notifications on the Open Web", 11 March 2015 — Chrome 42, must show a notification, desktop needs Chrome running, sender IDs for Chrome/Opera Android/Samsung Browser. https://developer.chrome.com/blog/push-notifications-on-the-open-web
- [WEBDEV-SUBSCRIBE] web.dev, "Subscribing a user" (2016) — `userVisibleOnly` required in Chrome. https://web.dev/articles/push-notifications-subscribing-a-user
- [WEBDEV-HANDLING] web.dev, "Handling push events" (2016) — `waitUntil`, "This site has been updated in the background." https://web.dev/articles/push-notifications-handling-messages
- [WEBDEV-PATTERNS] web.dev, "Common notification patterns" (2016) — focused-client check, `postMessage`, focus-or-open. https://web.dev/articles/push-notifications-common-notification-patterns
- [WEBDEV-DISPLAY] web.dev, "Displaying a notification" (2016) — per-option platform behaviour (badge Android-only, action icons, vibrate, no sound). https://web.dev/articles/push-notifications-display-a-notification
- [WEBDEV-PROTOCOL] web.dev, "The Web Push protocol", updated 20 September 2024 — TTL, Urgency, Topic, 404/410. https://web.dev/articles/push-notifications-web-push-protocol
- [CHROMIUM-PMNM] Chromium source, `chrome/browser/push_messaging/push_messaging_notification_manager.cc` (main) — visible-tab exemption, budget, generic notification. https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/push_messaging/push_messaging_notification_manager.cc
- [CHROMIUM-CHANNELS] Chromium, `chrome/android/.../notifications/channels/README.md` (66.0) — per-site channels from M62. https://chromium.googlesource.com/chromium/src/+/66.0.3359.158/chrome/android/java/src/org/chromium/chrome/browser/notifications/channels/README.md
- [CHROME-MAC] Chrome for Developers, "Native notifications on macOS", 26 April 2017 — Chrome 59, `image` ignored, action icons dropped. https://developer.chrome.com/blog/native-mac-os-notifications
- [CRUX-2020] Chrome for Developers, "Adding notification permission data to CrUX", 11 February 2020 — Chrome 80 quieter UI, auto-enrolment. https://developer.chrome.com/blog/notification-permission-data-in-crux
- [CHROME-138] Chrome 138 release notes (stable 24 June 2025) — `pushsubscriptionchange` on re-grant. https://developer.chrome.com/release-notes/138
- [CS-PSC-138] chromestatus 5147683423256576 "Pushsubscriptionchange event upon resubscription" (shipped 138). https://chromestatus.com/feature/5147683423256576
- [CS-PSC-DEV] chromestatus 6242325854420992 "PushSubscriptionChange" (In development). https://chromestatus.com/feature/6242325854420992
- [CS-EXPTIME] chromestatus 4929396687241216 "PushSubscription.expirationTime" — "Chrome will always return NULL, until we support subscription refreshes." https://chromestatus.com/feature/4929396687241216
- [CS-GCM-DEPR] chromestatus 5573539073622016 "Deprecation of GCM-based Web Push Subscriptions". https://chromestatus.com/feature/5573539073622016
- [CS-FCM-REMOVE] chromestatus 5187711071158272 "Remove support for Web Push Notifications using FCM Sender IDs" (Chrome 113, 2023). https://chromestatus.com/feature/5187711071158272
- [CHROMESTATUS-SEARCH] chromestatus API search for "declarative web push" (no entry), 2026-09-06. https://chromestatus.com/api/v0/features?q=declarative%20web%20push
- [GOOGLE-AUTOREVOKE] Google Chromium blog, "Reducing notification overload…", 10 October 2025 (Archit Agarwal). https://blog.google/chromium/automatic-notification-permission/
- [CHROME-RATELIMIT] Chrome for Developers, "Increasing web push notification value with rate limits", 6 January 2026. https://developer.chrome.com/blog/web-push-rate-limits
- [CHROME-155-PROMPT] Chrome for Developers, "Lighter notification prompts on Android", 22 July 2026 — Chrome 155. https://developer.chrome.com/blog/notification-prompts-android
- [CHROMIUM-DOZE] chromium.org push-notifications-dev thread, Oct 2017 — high-priority push not waking Chrome in Doze, acknowledged by Google. https://groups.google.com/a/chromium.org/g/push-notifications-dev/c/gWsM4Hg2JZE
- [ANDROID-DOZE] Android Developers, "Optimize for Doze and App Standby", updated 18 August 2026. https://developer.android.com/training/monitoring-device-state/doze-standby

Mozilla:

- [FF-72] Firefox 72.0 release notes, 7 January 2020 — gesture-bound notification prompts. https://www.firefox.com/en-US/firefox/72.0/releasenotes/
- [FF-152] Firefox 152.0 release notes, 16 June 2026 — notification `actions`. https://www.firefox.com/en-US/firefox/152.0/releasenotes/
- [BUGZ-1375683] Bugzilla 1375683 (meta) — quota of 16, visit-time decay, 3 s timer, server-side expiry without `pushsubscriptionchange` (Lina Cambridge, July 2017). https://bugzilla.mozilla.org/show_bug.cgi?id=1375683
- [BUGZ-1437919] Bugzilla 1437919 — throttle vs must-show; quota not enforced with the page open. https://bugzilla.mozilla.org/show_bug.cgi?id=1437919
- [BUGZ-1343678] Bugzilla 1343678 "Enable Web Push support in GeckoView", fixed, mozilla71. https://bugzilla.mozilla.org/show_bug.cgi?id=1343678
- [FENIX-771] mozilla-mobile/fenix #771 "Web Push Notifications" — push in Fenix regardless of foreground; PWA note. https://github.com/mozilla-mobile/fenix/issues/771
- [MOZ-SP-1176] mozilla/standards-positions #1176 "[Push API] Declarative Web Push" — position: positive (2025). https://github.com/mozilla/standards-positions/issues/1176
- [W3C-PUSH-360] w3c/push-api #360 "Declarative Web Push" (WebKit proposal, 11 September 2023). https://github.com/w3c/push-api/issues/360

Microsoft:

- [EDGE-PUSH] Microsoft Learn, "Re-engage users with push messages" (Edge PWA docs, updated 2 September 2026) — `userVisibleOnly` mandatory, generic notification. https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/push
- [EDGE-POLICY] Microsoft Learn, Edge policy `ForceBuiltInPushMessagingClient` (updated 15 June 2026) — WNS client, Edge ≥118. https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/forcebuiltinpushmessagingclient
- [EDGE-2018] Microsoft Edge blog, "Get started with web push notifications", 22 May 2018. https://blogs.windows.com/msedgedev/2018/05/22/get-started-web-push-notifications-tutorial-demo/
- [WNS] Microsoft Learn, "Windows Push Notification Services (WNS) overview" — channel URIs on `notify.windows.com`. https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/wns-overview
- [EDGE-DEVTOOLS-262] MicrosoftEdge/DevTools #262 — `*.notify.windows.com` web-push outage, July 2024. https://github.com/MicrosoftEdge/DevTools/issues/262
- [MS-QA-5686199] Microsoft Q&A, "Edge on Android and push subscription" — moderator answer 30 December 2025 (placeholder endpoint, delivery not functional). https://learn.microsoft.com/en-us/answers/questions/5686199/edge-on-android-and-push-subscription
- [MS-QA-5781524] Microsoft Q&A, "Microsoft Edge, Edge Beta on android are not receiving fcm/web push notifications", 19 February 2026 — version bisection. https://learn.microsoft.com/en-us/answers/questions/5781524/microsoft-edge-edge-beta-on-android-are-not-receiv

Brave:

- [BRAVE-2143] brave/brave-browser #2143 "Disable FCM" (2018) — "Brave on desktop does not support FCM. Brave on Android will stop supporting it in the future" (2019-03-18); subscribe hangs; no in-page signal. https://github.com/brave/brave-browser/issues/2143
- [BRAVE-2362] brave/brave-browser #2362 — proxied push, "off-by-default setting" (2019-09), "set to OFF by default" (2020-01-07), Google-endpoint rationale (2021-03-15). https://github.com/brave/brave-browser/issues/2362

Samsung:

- [SAMSUNG-PWA] Samsung Internet developer docs, "Progressive Web Apps" — Notification and Push API since v4. https://samsunginternet.github.io/docs/progressive-web-apps

Other:

- [BCD] mdn/browser-compat-data 8.1.0, `api/Notification.json`, `api/PushManager.json`, `api/PushSubscription.json`, `api/ServiceWorkerGlobalScope.json`, `api/Navigator.json` (last commit 2026-08-19). https://github.com/mdn/browser-compat-data
- [MDN-BADGE] MDN, `Notification.badge` — ~96 px, auto-masked on Android. https://developer.mozilla.org/en-US/docs/Web/API/Notification/badge
- [CAPACITOR] Capacitor Push Notifications plugin docs (v8) — APNs/FCM. https://capacitorjs.com/docs/apis/push-notifications
- [README] `README.md` — message rate limits (120/min per IP+address, 240/min per IP).
