import { beforeEach, describe, expect, test } from 'bun:test'
import { clearToken, getToken, saveToken, setActiveSessionAddress } from './session'

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
  setActiveSessionAddress(null)
})

describe('identity-bound session storage', () => {
  test('loads a token only for its active identity', () => {
    saveToken('0xAa', 'token-a')

    expect(getToken()).toBe('token-a')
    setActiveSessionAddress('0xBb')
    expect(getToken()).toBeNull()
    expect(values.has('eth_chat_session_v1')).toBe(false)
  })

  test('discards legacy unbound tokens', () => {
    values.set('eth_chat_token', 'legacy-token')
    setActiveSessionAddress('0xAa')

    expect(getToken()).toBeNull()
    expect(values.has('eth_chat_token')).toBe(false)
  })

  test('clears both current and legacy storage', () => {
    saveToken('0xAa', 'token-a')
    values.set('eth_chat_token', 'legacy-token')

    clearToken()

    expect(values.size).toBe(0)
    expect(getToken()).toBeNull()
  })
})
