import type { Address } from '../../shared/address'
import { identifierToSvg } from 'glyphid'

// A glyphid mosaic per address, so look-alike truncated addresses still differ
// at a glance. The canonical address keeps existing avatars stable.
export function AddressAvatar({ address, size = 24 }: { address: Address; size?: number }) {
  const __html = identifierToSvg(address, { variant: 'mosaic', theme: 'dark', size, decorative: true })
  return <span className="shrink-0 inline-flex" dangerouslySetInnerHTML={{ __html }} />
}
