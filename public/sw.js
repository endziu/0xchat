// App-shell service worker. Nothing sensitive is cached: /api/ is never touched,
// so ciphertexts, tokens and SSE traffic always go straight to the network.
// Push payloads are never read or cached either — see the push listener below.
// Bump on protocol releases: activation deletes every older shell and asset
// cache, so a client cached before the release cannot boot again offline.
// v3: recipient-opening lifecycle release gate.
const VERSION = 'v3'
const SHELL = `0xchat-shell-${VERSION}`
const ASSETS = `0xchat-assets-${VERSION}`

// Enough to boot the SPA offline; hashed JS/CSS are picked up lazily below.
const SHELL_URLS = ['/chat', '/manifest.webmanifest', '/icon-192.png', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // API and SSE must never be cached or replayed.
  if (url.pathname.startsWith('/api/')) return

  // Navigations: network-first so a deploy is picked up immediately, cached
  // shell only as an offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(SHELL).then((c) => c.put('/chat', copy))
          return res
        })
        .catch(() => caches.match('/chat').then((r) => r || caches.match(req))),
    )
    return
  }

  // Static assets: cache-first (filenames are content-hashed), revalidating in
  // the background so unhashed files like the icons still refresh.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone()
            caches.open(ASSETS).then((c) => c.put(req, copy))
          }
          return res
        })
        .catch(() => cached)
      return cached || network
    }),
  )
})

self.addEventListener('push', (event) => {
  // event.data is intentionally ignored — pushes carry no payload by design,
  // so the relay and this worker never learn who messaged whom or what.
  event.waitUntil(
    self.registration.showNotification('0xChat', {
      body: 'New message',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: '0xchat-message',
    }),
  )
})

// Native push calls (#85). Pages hand pushManager.subscribe, getSubscription
// and PushSubscription.unsubscribe to this worker instead of calling them
// themselves. The worker outlives a page reload, so a call started by a tab
// that has since closed keeps the native lock until the browser actually
// settles it, and every later call queues behind it. The lock is shared by
// every context of the origin, so it also orders calls across worker versions
// during an update. A request carries its page's remaining time budget: one
// still queued when that runs out never starts.
const NATIVE_LOCK = '0xchat.push.native'
const PUSH_CHANNEL = '0xchat.push'
let nativeTail = Promise.resolve()

function exclusively(task) {
  const locks = self.navigator && self.navigator.locks
  if (locks) return locks.request(NATIVE_LOCK, { mode: 'exclusive' }, task)
  const run = nativeTail.then(task)
  nativeTail = run.catch(() => {})
  return run
}

async function runNative(request, expiresAt) {
  if (Date.now() >= expiresAt) return { status: 'expired' }
  const push = self.registration.pushManager
  if (request.op === 'subscribe') {
    const sub = await push.subscribe({ userVisibleOnly: true, applicationServerKey: request.applicationServerKey })
    return { status: 'done', subscription: sub.toJSON() }
  }
  const sub = await push.getSubscription()
  if (request.op === 'get') return { status: 'done', subscription: sub ? sub.toJSON() : null }
  // Remove only the subscription the page saw, never one created since.
  if (!sub) return { status: 'done', removed: true }
  if (sub.endpoint !== request.endpoint) return { status: 'done', removed: false }
  return { status: 'done', removed: await sub.unsubscribe() }
}

self.addEventListener('message', (event) => {
  const request = event.data
  const port = event.ports && event.ports[0]
  if (!request || request.type !== 'push-native' || !port) return
  const expiresAt = Date.now() + Math.max(0, Number(request.timeLeft) || 0)
  // Keep the worker alive until the browser call settles, whoever is listening.
  event.waitUntil(exclusively(() => runNative(request, expiresAt))
    .catch((err) => ({ status: 'failed', message: String((err && err.message) || err) }))
    .then((reply) => {
      port.postMessage(reply)
      // A settled removal, even one whose page is gone, can turn notifications
      // off in every tab. A new subscription is announced by the page that
      // uploads it; one whose page has gone binds nothing new.
      if (request.op === 'unsubscribe' && reply.status !== 'expired' && typeof BroadcastChannel === 'function') {
        const channel = new BroadcastChannel(PUSH_CHANNEL)
        channel.postMessage({ type: 'push-state-changed' })
        channel.close()
      }
    }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const usableClients = clients.filter((client) => {
        if (typeof client.focus !== 'function') return false
        try {
          return new URL(client.url).origin === self.location.origin
        } catch {
          return false
        }
      })
      usableClients.sort((a, b) => {
        const rank = (client) => client.focused ? 0 : client.visibilityState === 'visible' ? 1 : 2
        return rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      })
      return usableClients[0]?.focus() || self.clients.openWindow('/chat')
    }),
  )
})
