import { verifyAddressBoundPublicKey } from '../../shared/address-bound-pubkey'

export function verifyEncryptionPublicKey(address: string, value: string): string {
  const result = verifyAddressBoundPublicKey(address.trim(), value)
  if (!result.ok) {
    if (result.reason === 'address-mismatch') {
      throw new Error('Encryption public key does not match address')
    }
    throw new Error('Invalid encryption public key')
  }

  return `0x${result.publicKey}`
}
