import { expect, test } from 'bun:test'
import { parseAddress, isCanonicalAddress, checksumAddress, shortAddress } from './address'

test('external casing converges on one address while protocol validation stays strict', () => {
  const lower = '0x52908400098527886e0f7030069857d2e4169ee7'
  const checksum = '0x52908400098527886E0F7030069857D2E4169EE7'
  const address = parseAddress(checksum)
  expect<string | null>(address).toBe(lower)
  expect(parseAddress(lower)).toBe(address)
  // Input is shape-validated, deliberately not checksum-validated (legacy compatibility).
  expect(parseAddress('0x52908400098527886e0F7030069857D2E4169EE7')).toBe(address)
  expect(isCanonicalAddress(lower)).toBe(true)
  expect(isCanonicalAddress(checksum)).toBe(false)
  expect(checksumAddress(address!)).toBe(checksum)
  expect(shortAddress(address!)).toBe('0x5290…9EE7')
  for (const invalid of [null, 123, '', lower.slice(1), `${lower}0`, lower.replace('7', 'g')]) {
    expect(parseAddress(invalid)).toBeNull()
    expect(isCanonicalAddress(invalid)).toBe(false)
  }
})
