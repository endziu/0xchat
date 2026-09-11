import { MESSAGE_LIFETIMES } from '../lib/message-lifetime'

// The supported message lifetimes as <option>s, shared by the composer and
// the settings section so the two lists cannot drift apart.
export function LifetimeOptions() {
  return <>{MESSAGE_LIFETIMES.map((o) => <option key={o.seconds} value={o.seconds}>{o.label}</option>)}</>
}
