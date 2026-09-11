import { beforeEach, describe, expect, test } from 'bun:test'
import {
  MESSAGE_LIFETIMES,
  getDefaultLifetimeSetting,
  rememberLifetimeSelection,
  resolveComposerLifetime,
  setDefaultLifetimeSetting,
} from './message-lifetime'

const values = new Map<string, string>()

globalThis.localStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) },
  clear: () => values.clear(),
  key: (index: number) => [...values.keys()][index] ?? null,
  get length() { return values.size },
} as Storage

beforeEach(() => {
  values.clear()
})

describe('composer message lifetime', () => {
  test('new users start with 30 minutes', () => {
    expect(resolveComposerLifetime()).toBe(1800)
  })

  test('reuses the latest selection when no default is configured', () => {
    rememberLifetimeSelection(300)
    rememberLifetimeSelection(3600)

    expect(resolveComposerLifetime()).toBe(3600)
  })

  test('a configured default takes precedence over the remembered selection', () => {
    rememberLifetimeSelection(3600)
    setDefaultLifetimeSetting(60)

    expect(resolveComposerLifetime()).toBe(60)
  })

  test('overriding a single message lifetime does not change the configured default', () => {
    setDefaultLifetimeSetting(60)
    rememberLifetimeSelection(86400)

    expect(getDefaultLifetimeSetting()).toBe(60)
    expect(resolveComposerLifetime()).toBe(60)
  })

  test('choosing "Remember last selection" clears the fixed default', () => {
    rememberLifetimeSelection(3600)
    setDefaultLifetimeSetting(60)
    setDefaultLifetimeSetting(null)

    expect(getDefaultLifetimeSetting()).toBeNull()
    expect(resolveComposerLifetime()).toBe(3600)
  })

  test('ignores stored values that are not supported lifetimes', () => {
    values.set('0xchat_default_message_lifetime_v1', 'garbage')
    values.set('0xchat_last_message_lifetime_v1', '999')

    expect(getDefaultLifetimeSetting()).toBeNull()
    expect(resolveComposerLifetime()).toBe(1800)
  })

  test('offers every supported lifetime from 5 seconds to 24 hours', () => {
    expect(MESSAGE_LIFETIMES.map((o) => o.seconds)).toEqual([5, 10, 30, 60, 300, 1800, 3600, 21600, 86400])
    expect(MESSAGE_LIFETIMES.map((o) => o.label)).toEqual(['5s', '10s', '30s', '1m', '5m', '30m', '1h', '6h', '24h'])
  })
})
