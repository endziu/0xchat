import { identifierToSvg } from 'glyphid'

// A glyphid mosaic per address, so look-alike truncated addresses still differ
// at a glance. Lowercased: the same address arrives both checksummed and not.
export function AddressAvatar({ address, size = 24 }: { address: string; size?: number }) {
  const __html = identifierToSvg(address.toLowerCase(), { variant: 'mosaic', theme: 'dark', size, decorative: true })
  return <span className="shrink-0 inline-flex" dangerouslySetInnerHTML={{ __html }} />
}
