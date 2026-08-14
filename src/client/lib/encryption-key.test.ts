import { describe, expect, test } from 'bun:test'
import * as secp from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildRegistrationChallenge } from '../../shared/registration-challenge'
import { verifyEncryptionPublicKey } from './encryption-key'

const privateKey = `0x${'11'.repeat(32)}` as const
const address = privateKeyToAccount(privateKey).address
const publicKey = bytesToHex(secp.getPublicKey(hexToBytes(privateKey), true))

describe('registration challenge', () => {
  test('canonically binds origin, address, key, and nonce', () => {
    expect(buildRegistrationChallenge('https://chat.example', address, publicKey, 'abc')).toBe(
      `0xChat key registration v1\nOrigin: https://chat.example\nAddress: ${address.toLowerCase()}\nPublic key: ${publicKey}\nNonce: abc`,
    )
  })
})

describe('verifyEncryptionPublicKey', () => {
  test('returns a normalized key only when it belongs to the requested address', () => {
    expect(verifyEncryptionPublicKey(address.toLowerCase(), publicKey.toUpperCase())).toBe(publicKey)
  })

  test('rejects malformed, off-curve, and address-mismatched keys', () => {
    expect(() => verifyEncryptionPublicKey(address, '0x1234')).toThrow()
    expect(() => verifyEncryptionPublicKey(address, `0x02${'00'.repeat(32)}`)).toThrow()
    expect(() => verifyEncryptionPublicKey(`0x${'22'.repeat(20)}`, publicKey)).toThrow()
  })
})
