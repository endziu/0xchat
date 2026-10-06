export function ensure0x(s: string): `0x${string}` {
  return s.startsWith('0x') ? (s as `0x${string}`) : `0x${s}`
}
