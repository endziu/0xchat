import { checksumAddress, type Address } from '../../shared/address'

// The full checksummed address in groups of four, "0x" first, so it can be
// read aloud or compared by eye. Copying the text still yields the address.
export function AddressHex({ address, className = '' }: { address: Address; className?: string }) {
  const full = checksumAddress(address)
  const groups = [full.slice(0, 2), ...full.slice(2).match(/.{4}/g)!]
  return (
    <span className={`inline-flex flex-wrap justify-center gap-x-[0.55ch] font-mono leading-relaxed text-text ${className}`}>
      {groups.map((group, i) => <span key={i}>{group}</span>)}
    </span>
  )
}
