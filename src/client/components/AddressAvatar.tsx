import type { Address } from '../../shared/address'
import { identifierToSvg } from 'glyphid'

// A glyphid mosaic per address, so look-alike truncated addresses still differ
// at a glance. The canonical address keeps existing avatars stable. `size` is
// px at the base text size, applied in rem so the glyph grows with the desktop
// UI scale the way the icons do. Centred on a line box, the glyph sits about a
// pixel below the text, whose descender space is mostly empty; the lift puts
// its middle on the middle of the letters.
export function AddressAvatar({ address, size = 24 }: { address: Address; size?: number }) {
  const __html = identifierToSvg(address, { variant: 'mosaic', theme: 'dark', size, decorative: true })
  const rem = `${size / 16}rem`
  return <span className="shrink-0 inline-flex -translate-y-[0.05em] [&>svg]:size-full" style={{ width: rem, height: rem }} dangerouslySetInnerHTML={{ __html }} />
}
