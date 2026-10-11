// Light or dark, chosen per browser. System (the default) follows the OS's
// prefers-color-scheme live. public/theme.js applies the same choice before
// first paint; this module keeps it applied once the app is running.

export type ThemeSetting = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

// Shared with public/theme.js, which cannot import it.
export const THEME_STORAGE_KEY = '0xchat_theme_v1'
// The browser chrome matches the panels' surface colour.
export const THEME_COLORS: Record<Theme, string> = { light: '#fbfaf8', dark: '#1c1b19' }

const DARK_QUERY = '(prefers-color-scheme: dark)'
const listeners = new Set<() => void>()

export function getThemeSetting(): ThemeSetting {
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

export function resolvedTheme(): Theme {
  const setting = getThemeSetting()
  if (setting !== 'system') return setting
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

function applyTheme() {
  const theme = resolvedTheme()
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme])
}

function changed() {
  applyTheme()
  for (const listener of listeners) listener()
}

export function setThemeSetting(setting: ThemeSetting) {
  if (setting === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
  else localStorage.setItem(THEME_STORAGE_KEY, setting)
  changed()
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Applies the theme and follows OS changes while the setting is System. */
export function startTheme(): () => void {
  applyTheme()
  const query = window.matchMedia(DARK_QUERY)
  const onChange = () => { if (getThemeSetting() === 'system') changed() }
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
