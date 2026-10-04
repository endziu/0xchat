import { shortAddress, type Address } from '../../shared/address'
// How addresses, names and times are shown to a person.

export const shortAddr = shortAddress

/** The conversation label, "You" for your own address, else the short address. */
export function displayName(address: Address, labels: Record<Address, string>, self: Address): string {
  const key = address
  if (key === self) return 'You'
  return labels[key] || shortAddr(address)
}

export const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

const startOfDay = (ts: number) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }

/** null for today, "Yesterday", then a weekday within a week, else a date. */
export function fmtDay(ts: number, now = Date.now()): string | null {
  // Rounded: a day across a DST change is 23 or 25 hours long.
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000)
  if (days <= 0) return null
  if (days === 1) return 'Yesterday'
  if (days < 7) return new Date(ts).toLocaleDateString([], { weekday: 'short' })
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Time left until `expiresAt`, in its largest whole unit: 12s, 29m, 4h. */
export function fmtRemaining(expiresAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}
