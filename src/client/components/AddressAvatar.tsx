import type { Address } from '../../shared/address'
import { identifierToSvg } from 'glyphid'
import { useTheme } from '../hooks/useTheme'

// A glyphid mosaic per address, so look-alike truncated addresses still differ
// at a glance. The canonical address keeps existing avatars stable; the mosaic
// is drawn for the current light or dark theme.
export function AddressAvatar({ address, size = 24 }: { address: Address; size?: number }) {
  const { theme } = useTheme()
  const __html = identifierToSvg(address, { variant: 'mosaic', theme, size, decorative: true })
  return <span className="shrink-0 inline-flex overflow-hidden rounded-[22%] [&>svg]:size-full" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html }} />
}
