import { expect, test } from 'bun:test'
import { requireAddress } from '../../shared/address'
import { conversationPath, parseConversationPath, parseScannedAddress } from './address-links'

test('shared links and QR payloads resolve to the same canonical conversation as raw input', () => {
  const address = requireAddress('0x52908400098527886e0f7030069857d2e4169ee7')
  const path = '/chat/0x52908400098527886E0F7030069857D2E4169EE7'
  expect(conversationPath(address)).toBe(path)
  expect(parseConversationPath(path)).toBe(address)
  expect(parseConversationPath(`/chat/${address}`)).toBe(address)
  expect(parseScannedAddress(`https://chat.example${path}`)).toBe(address)
  expect(parseScannedAddress(` ${address} `)).toBe(address)
  expect(parseScannedAddress('https://chat.example/chat/invalid')).toBeNull()
  expect(parseConversationPath(`${path}/extra`)).toBeNull()
})
