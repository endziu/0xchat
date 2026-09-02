import * as secp from '@noble/secp256k1'
import { hexToBytes, keccak256 } from 'viem'

export type AddressBoundPublicKeyResult =
  | { ok: true; publicKey: string }
  | { ok: false; reason: 'invalid-public-key' | 'address-mismatch' }

export function verifyAddressBoundPublicKey(
  address: string,
  candidatePublicKey: unknown,
): AddressBoundPublicKeyResult {
  if (typeof candidatePublicKey !== 'string') return { ok: false, reason: 'invalid-public-key' }

  const trimmed = candidatePublicKey.trim()
  const publicKey = (/^0x/i.test(trimmed) ? trimmed.slice(2) : trimmed).toLowerCase()
  if (!/^0[23][0-9a-f]{64}$/.test(publicKey)) {
    return { ok: false, reason: 'invalid-public-key' }
  }

  try {
    const point = secp.Point.fromBytes(hexToBytes(`0x${publicKey}`))
    const uncompressed = point.toBytes(false)
    const derivedAddress = `0x${keccak256(uncompressed.slice(1)).slice(-40)}`.toLowerCase()
    if (derivedAddress !== address.toLowerCase()) {
      return { ok: false, reason: 'address-mismatch' }
    }
  } catch {
    return { ok: false, reason: 'invalid-public-key' }
  }

  return { ok: true, publicKey }
}
