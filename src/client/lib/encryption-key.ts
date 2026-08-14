import * as secp from '@noble/secp256k1'
import { hexToBytes, keccak256 } from 'viem'

export function buildRegistrationChallenge(
  origin: string,
  address: string,
  publicKey: string,
  nonce: string,
): string {
  return [
    '0xChat key registration v1',
    `Origin: ${origin}`,
    `Address: ${address.toLowerCase()}`,
    `Public key: ${publicKey.toLowerCase()}`,
    `Nonce: ${nonce}`,
  ].join('\n')
}

export function verifyEncryptionPublicKey(address: string, value: string): string {
  const normalizedAddress = address.trim().toLowerCase()
  const trimmed = value.trim()
  const hex = /^0x/i.test(trimmed) ? trimmed.slice(2).toLowerCase() : trimmed.toLowerCase()

  if (!/^0[23][0-9a-f]{64}$/.test(hex)) {
    throw new Error('Invalid encryption public key')
  }

  let derivedAddress: string
  try {
    const point = secp.Point.fromBytes(hexToBytes(`0x${hex}`))
    const uncompressed = point.toBytes(false)
    derivedAddress = `0x${keccak256(uncompressed.slice(1)).slice(-40)}`.toLowerCase()
  } catch {
    throw new Error('Invalid encryption public key')
  }

  if (derivedAddress !== normalizedAddress) {
    throw new Error('Encryption public key does not match address')
  }

  return `0x${hex}`
}
