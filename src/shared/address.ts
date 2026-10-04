import { getAddress } from 'viem'

declare const addressBrand: unique symbol
/** A validated, full, lowercase Ethereum address. */
export type Address = `0x${string}` & { readonly [addressBrand]: true }

/** Protocol data must already be canonical; never rewrite signed fields. */
export function isCanonicalAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value)
}

/**
 * External input is shape-validated, not checksum-validated. Accept all casing
 * for compatibility with existing links, identities and storage. Human input
 * adapters may trim whitespace before parsing; protocol parsers must use
 * isCanonicalAddress instead.
 */
export function parseAddress(value: unknown): Address | null {
  if (typeof value !== 'string') return null
  const canonical = value.toLowerCase()
  return value.startsWith('0x') && isCanonicalAddress(canonical) ? canonical : null
}

export function requireAddress(value: unknown): Address {
  const address = parseAddress(value)
  if (!address) throw new Error('Expected an Ethereum address (0x followed by 40 hex digits)')
  return address
}

export function checksumAddress(address: Address): string {
  return getAddress(address)
}

export function shortAddress(address: Address): string {
  const full = checksumAddress(address)
  return `${full.slice(0, 6)}…${full.slice(-4)}`
}
