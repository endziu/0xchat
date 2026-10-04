import type { Address } from '../../shared/address'
import { verifyAddressBoundPublicKey } from '../../shared/address-bound-pubkey'

export function verifyEncryptionPublicKey(address: Address, value: string): string {
  const result = verifyAddressBoundPublicKey(address, value)
  if (!result.ok) {
    if (result.reason === 'address-mismatch') {
      throw new Error('Encryption public key does not match address')
    }
    throw new Error('Invalid encryption public key')
  }

  return `0x${result.publicKey}`
}
