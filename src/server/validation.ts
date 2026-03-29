export function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(addr);
}

export function isHex(s: string, byteLen?: number): boolean {
  const hex = s.startsWith('0x') ? s.slice(2) : s;
  if (byteLen !== undefined) {
    return hex.length === byteLen * 2 && /^[0-9a-f]+$/i.test(hex);
  }
  return hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-f]+$/i.test(hex);
}

export function isValidSig(sig: string): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(sig);
}

export function normalizeHex(s: unknown): string {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim().toLowerCase();
  return trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
}
