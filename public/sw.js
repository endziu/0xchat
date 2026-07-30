// App-shell service worker. Nothing sensitive is cached: /api/ is never touched,
// so ciphertexts, tokens and SSE traffic always go straight to the network.
const VERSION = 'v1'
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
