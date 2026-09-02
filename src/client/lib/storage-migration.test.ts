import { beforeEach, describe, expect, test } from 'bun:test'
import { migrateKey } from './storage-migration'

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

describe('storage key migration', () => {
  test('moves an old value to the new key', () => {
    values.set('old', 'legacy')

    migrateKey('old', 'new')

    expect(values.get('new')).toBe('legacy')
    expect(values.has('old')).toBe(false)
  })

  test('keeps the new value and removes a stale old value', () => {
    values.set('old', 'legacy')
    values.set('new', 'current')

    migrateKey('old', 'new')

    expect(values.get('new')).toBe('current')
    expect(values.has('old')).toBe(false)
  })
})
