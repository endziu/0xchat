// Applies the saved light/dark choice before first paint, so the page never
// flashes the wrong theme. A blocking external script because the CSP forbids
// inline ones. Mirrors src/client/lib/theme.ts, which takes over once the app runs.
;(function () {
  var colors = { light: '#fbfaf8', dark: '#1c1b19' }
  var stored = null
  try { stored = localStorage.getItem('0xchat_theme_v1') } catch (e) {}
  var theme = stored === 'light' || stored === 'dark'
    ? stored
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', colors[theme])
})()
