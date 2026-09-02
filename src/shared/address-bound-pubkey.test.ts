import { describe, expect, test } from 'bun:test'
import * as secp from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { verifyAddressBoundPublicKey } from './address-bound-pubkey'

const privateKey = `0x${'11'.repeat(32)}` as const
const address = privateKeyToAccount(privateKey).address
const publicKey = bytesToHex(secp.getPublicKey(hexToBytes(privateKey), true))

describe('verifyAddressBoundPublicKey', () => {
  test('returns a normalized public key when it belongs to the address', () => {
    expect(verifyAddressBoundPublicKey(address, publicKey.toUpperCase())).toEqual({
      ok: true,
      publicKey: publicKey.slice(2),
    })
  })

  test('distinguishes malformed and off-curve keys from an address mismatch', () => {
    const invalid = { ok: false, reason: 'invalid-public-key' } as const

    expect(verifyAddressBoundPublicKey(address, '0x1234')).toEqual(invalid)
    expect(verifyAddressBoundPublicKey(address, `0x02${'00'.repeat(32)}`)).toEqual(invalid)
    expect(verifyAddressBoundPublicKey(address, null)).toEqual(invalid)
    expect(verifyAddressBoundPublicKey(`0x${'22'.repeat(20)}`, publicKey)).toEqual({
      ok: false,
      reason: 'address-mismatch',
    })
  })
})
