import { requireAddress } from '../../shared/address'
import { beforeEach, describe, expect, test } from 'bun:test'
import { clearToken, clearTokenIfMatches, getToken, saveToken } from './session'

const SESSION_KEY = 'hushhash_session_v1'

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
    saveToken(requireAddress('0xaa00000000000000000000000000000000000000'), 'token-a')

    expect(getToken(requireAddress('0xaa00000000000000000000000000000000000000'))).toBe('token-a')
    expect(getToken(requireAddress('0xbb00000000000000000000000000000000000000'))).toBeNull()
    expect(values.has(SESSION_KEY)).toBe(false)
  })

  test('clears the stored session', () => {
    saveToken(requireAddress('0xaa00000000000000000000000000000000000000'), 'token-a')

    clearToken()

    expect(values.has(SESSION_KEY)).toBe(false)
    expect(getToken(requireAddress('0xaa00000000000000000000000000000000000000'))).toBeNull()
  })
})

describe('clearTokenIfMatches', () => {
  test('clears and reports a match for the stored token', () => {
    saveToken(requireAddress('0xaa00000000000000000000000000000000000000'), 'token-a')
    expect(clearTokenIfMatches('token-a')).toBe(true)
    expect(values.has(SESSION_KEY)).toBe(false)
  })

  test('keeps a newer session when the token does not match', () => {
    saveToken(requireAddress('0xaa00000000000000000000000000000000000000'), 'token-b')
    expect(clearTokenIfMatches('token-a')).toBe(false)
    expect(getToken(requireAddress('0xaa00000000000000000000000000000000000000'))).toBe('token-b')
  })

  test('a stale token against corrupt storage does not report a match', () => {
    values.set(SESSION_KEY, '{not-json')
    expect(clearTokenIfMatches('token-a')).toBe(false)
  })
})
