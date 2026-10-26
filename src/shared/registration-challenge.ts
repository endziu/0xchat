import type { Address } from './address'
export function buildRegistrationChallenge(
  origin: string,
  address: Address,
  publicKey: string,
  nonce: string,
): string {
  const normalizedPublicKey = publicKey.replace(/^0x/i, '').toLowerCase()
  return [
    'hushhash key registration v1',
    `Origin: ${origin}`,
    `Address: ${address}`,
    `Public key: 0x${normalizedPublicKey}`,
    `Nonce: ${nonce}`,
  ].join('\n')
}
