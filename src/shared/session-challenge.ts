export function buildSessionChallenge(
  origin: string,
  address: string,
  nonce: string,
): string {
  return [
    '0xChat session request',
    `Origin: ${origin}`,
    `Address: ${address.toLowerCase()}`,
    `Nonce: ${nonce}`,
  ].join('\n');
}
