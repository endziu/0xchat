import { beforeEach, describe, expect, test } from 'bun:test'
import { clearToken, clearTokenIfMatches, getToken, saveToken } from './session'

const OLD_SESSION_KEY = 'eth_chat_session_v1'
const NEW_SESSION_KEY = '0xchat_session_v1'

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

describe('identity-bound session storage', () => {
  test('loads a token only for its stored identity', () => {
    saveToken('0xAa', 'token-a')

    expect(getToken('0xAa')).toBe('token-a')
    expect(getToken('0xBb')).toBeNull()
    expect(values.has(NEW_SESSION_KEY)).toBe(false)
  })

  test('discards legacy unbound tokens', () => {
    values.set('eth_chat_token', 'legacy-token')

    expect(getToken('0xAa')).toBeNull()
    expect(values.has('eth_chat_token')).toBe(false)
    expect(values.has(NEW_SESSION_KEY)).toBe(false)
  })

  test('clears both current and legacy storage', () => {
    saveToken('0xAa', 'token-a')
    values.set('eth_chat_token', 'legacy-token')
    values.set(OLD_SESSION_KEY, 'should-not-matter')

    clearToken()

    expect(values.has(NEW_SESSION_KEY)).toBe(false)
    expect(getToken('0xAa')).toBeNull()
  })
})

describe('clearTokenIfMatches', () => {
  test('clears and reports a match for the stored token', () => {
    saveToken('0xAa', 'token-a')
    expect(clearTokenIfMatches('token-a')).toBe(true)
    expect(values.has(NEW_SESSION_KEY)).toBe(false)
  })

  test('keeps a newer session when the token does not match', () => {
    saveToken('0xAa', 'token-b')
    expect(clearTokenIfMatches('token-a')).toBe(false)
    expect(getToken('0xAa')).toBe('token-b')
  })

  test('a stale token against corrupt storage does not report a match', () => {
    values.set(NEW_SESSION_KEY, '{not-json')
    expect(clearTokenIfMatches('token-a')).toBe(false)
  })
})