import type { Address } from './address'
export function buildSessionChallenge(
  origin: string,
  address: Address,
  nonce: string,
): string {
  return [
    'hushhash session request',
    `Origin: ${origin}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
  ].join('\n');
}
