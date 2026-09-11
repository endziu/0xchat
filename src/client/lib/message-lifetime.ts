// Composer message lifetime preferences: a configured default, or the
// most recently selected lifetime when no default is configured.

const DEFAULT_SETTING_KEY = '0xchat_default_message_lifetime_v1'
const LAST_SELECTION_KEY = '0xchat_last_message_lifetime_v1'

export interface MessageLifetimeOption {
  seconds: number
  label: string
}

export const MESSAGE_LIFETIMES: readonly MessageLifetimeOption[] = [
  { seconds: 5, label: '5s' },
  { seconds: 10, label: '10s' },
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '1m' },
  { seconds: 300, label: '5m' },
  { seconds: 1800, label: '30m' },
  { seconds: 3600, label: '1h' },
  { seconds: 21600, label: '6h' },
  { seconds: 86400, label: '24h' },
]

export const FALLBACK_MESSAGE_LIFETIME = 1800

function readLifetime(key: string): number | null {
  const raw = localStorage.getItem(key)
  if (raw === null) return null
  const seconds = Number(raw)
  return MESSAGE_LIFETIMES.some((o) => o.seconds === seconds) ? seconds : null
}

// `null` means "Remember last selection": no fixed default is configured.
export function getDefaultLifetimeSetting(): number | null {
  return readLifetime(DEFAULT_SETTING_KEY)
}

export function setDefaultLifetimeSetting(seconds: number | null) {
  if (seconds === null) localStorage.removeItem(DEFAULT_SETTING_KEY)
  else localStorage.setItem(DEFAULT_SETTING_KEY, String(seconds))
}

export function rememberLifetimeSelection(seconds: number) {
  localStorage.setItem(LAST_SELECTION_KEY, String(seconds))
}

export function resolveComposerLifetime(): number {
  return getDefaultLifetimeSetting() ?? readLifetime(LAST_SELECTION_KEY) ?? FALLBACK_MESSAGE_LIFETIME
}
