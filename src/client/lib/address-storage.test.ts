import { beforeEach, expect, test } from 'bun:test'
import { requireAddress } from '../../shared/address'
import { loadKeypair } from './burner'
import { getToken } from './session'
import { loadContacts, isRemoved, getLastSeenKey, loadLabels } from './contacts'

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

test('legacy casing preserves identity, session, labels, removals and newest read markers', () => {
  const legacy = '0x52908400098527886E0F7030069857D2E4169EE7'
  const address = requireAddress(legacy)
  values.set('eth_chat_burner_v1', JSON.stringify({ address: legacy, privateKey: 'key', publicKey: 'pubkey' }))
  values.set('eth_chat_session_v1', JSON.stringify({ address: legacy, token: 'token' }))
  values.set('eth_chat_known_contacts_v1', JSON.stringify({ [legacy]: { address: legacy, last_message_at: 20 }, [address]: { address, last_message_at: 10 } }))
  values.set('conversation_labels', JSON.stringify({ [legacy]: 'Alice' }))
  values.set('eth_chat_deleted_contacts_v1', JSON.stringify({ [legacy]: 30, [address]: 10 }))
  values.set(`last_seen_${legacy}`, '25')
  values.set(`last_seen_${address}`, '15')

  expect(loadKeypair()?.address).toBe(address)
  expect(getToken(address)).toBe('token')
  expect(loadContacts()).toEqual({ [address]: { address, last_message_at: 20 } })
  expect(loadLabels()).toEqual({ [address]: 'Alice' })
  expect(isRemoved(address, 29)).toBe(true)
  expect(localStorage.getItem(getLastSeenKey(address))).toBe('25')
  expect(JSON.parse(values.get('0xchat_session_v1')!).address).toBe(address)
  expect(JSON.parse(values.get('0xchat_burner_v1')!).address).toBe(address)
  expect(values.has(`last_seen_${legacy}`)).toBe(false)
})
