import { addressHue } from '../lib/display'

// The ⬡ brand mark (public/favicon.svg), tinted per address so look-alike
// truncated addresses still differ at a glance.
export function AddressAvatar({ address, size = 16 }: { address: string; size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" className="shrink-0">
      <path
        d="M16 4.5 26 10.25v11.5L16 27.5 6 21.75v-11.5Z"
        fill={`hsl(${addressHue(address)} 70% 60% / 0.25)`}
        stroke={`hsl(${addressHue(address)} 70% 60%)`}
        stroke-width="3"
        stroke-linejoin="round"
      />
    </svg>
  )
}
