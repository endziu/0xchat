import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

let theme: typeof import('./theme')
let osDark: boolean
const osListeners = new Set<() => void>()

// The OS colour scheme, switchable mid-test the way a device's auto dark mode does.
function setOsDark(dark: boolean) {
  osDark = dark
  for (const listener of osListeners) listener()
}

function stubMatchMedia(target: { matchMedia: unknown }) {
  target.matchMedia = (query: string) => ({
    get matches() { return query === '(prefers-color-scheme: dark)' && osDark },
    addEventListener: (_type: string, listener: () => void) => osListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => osListeners.delete(listener),
  })
}

const applied = () => document.documentElement.dataset.theme
const themeColor = () => document.querySelector('meta[name="theme-color"]')?.getAttribute('content')

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost' })
  stubMatchMedia(window)
  theme = await import('./theme')
})
afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  localStorage.clear()
  osListeners.clear()
  osDark = false
  delete document.documentElement.dataset.theme
  document.head.innerHTML = '<meta name="theme-color" content="#000000">'
})

// The blocking boot script in index.html runs before the app's modules, so it
// is tested on its own: it must agree with the app about the stored choice.
async function boot() {
  const script = await Bun.file(new URL('../../../public/theme.js', import.meta.url)).text()
  Function('window', 'document', 'localStorage', script)(window, document, localStorage)
}

test('the boot script applies a saved choice before first paint, whatever the OS says', async () => {
  osDark = true
  theme.setThemeSetting('light')
  delete document.documentElement.dataset.theme
  await boot()
  expect(applied()).toBe('light')
  expect(themeColor()).toBe(theme.THEME_COLORS.light)
})

test.each([
  [false, 'light'],
  [true, 'dark'],
] as const)('without a saved choice the boot script follows the OS (dark: %p)', async (dark, expected) => {
  osDark = dark
  await boot()
  expect(applied()).toBe(expected)
  expect(themeColor()).toBe(theme.THEME_COLORS[expected])
})

test('an unknown saved value counts as System', async () => {
  localStorage.setItem(theme.THEME_STORAGE_KEY, 'sepia')
  osDark = true
  await boot()
  expect(applied()).toBe('dark')
  expect(theme.getThemeSetting()).toBe('system')
})

test('System is the default and follows the OS live', () => {
  const stop = theme.startTheme()
  try {
    expect(theme.getThemeSetting()).toBe('system')
    expect(applied()).toBe('light')
    setOsDark(true)
    expect(applied()).toBe('dark')
    expect(theme.resolvedTheme()).toBe('dark')
  } finally { stop() }
})

test('Light and Dark override the OS, survive a reload and tell subscribers', () => {
  const stop = theme.startTheme()
  const seen: string[] = []
  const unsubscribe = theme.subscribeTheme(() => seen.push(`${theme.getThemeSetting()}:${theme.resolvedTheme()}`))
  try {
    theme.setThemeSetting('dark')
    expect(applied()).toBe('dark')
    setOsDark(false)
    expect(applied()).toBe('dark')
    expect(localStorage.getItem(theme.THEME_STORAGE_KEY)).toBe('dark')

    theme.setThemeSetting('system')
    expect(applied()).toBe('light')
    expect(localStorage.getItem(theme.THEME_STORAGE_KEY)).toBeNull()
    expect(seen).toEqual(['dark:dark', 'system:light'])
  } finally {
    unsubscribe()
    stop()
  }
})
