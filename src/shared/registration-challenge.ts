export function buildRegistrationChallenge(
  origin: string,
  address: string,
  publicKey: string,
  nonce: string,
): string {
  const normalizedPublicKey = publicKey.replace(/^0x/i, '').toLowerCase()
  return [
    '0xChat key registration v1',
    `Origin: ${origin}`,
    `Address: ${address.toLowerCase()}`,
    `Public key: 0x${normalizedPublicKey}`,
    `Nonce: ${nonce}`,
  ].join('\n')
}
