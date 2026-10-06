import { beforeEach, expect, test } from 'bun:test'
import { checksumAddress } from '../../shared/address'
import { deriveKeypair } from '../../shared/keypair'
import { loadKeypair } from './keypair-storage'

const values = new Map<string, string>()
globalThis.localStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) },
  clear: () => values.clear(),
  key: (index: number) => [...values.keys()][index] ?? null,
  get length() { return values.size },
} as Storage
beforeEach(() => values.clear())

test('a stored identity loads by its private key, whatever its stored address says', () => {
  const keypair = deriveKeypair(`0x${'12'.repeat(32)}`)
  for (const address of [checksumAddress(keypair.address), 'corrupt', undefined]) {
    values.set('eth_chat_burner_v1', JSON.stringify({ ...keypair, address }))
    expect(loadKeypair()).toEqual(keypair)
  }
})
