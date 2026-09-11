import { useState } from 'preact/hooks'
import { MESSAGE_LIFETIMES, getDefaultLifetimeSetting, setDefaultLifetimeSetting } from '../lib/message-lifetime'

// Sentinel option value for "no fixed default": reuse the last selection.
const REMEMBER_LAST = 'remember'

export function MessageLifetimeSettings() {
  const [setting, setSetting] = useState<number | null>(getDefaultLifetimeSetting)

  const handleChange = (e: any) => {
    const value = e.target.value === REMEMBER_LAST ? null : Number(e.target.value)
    setDefaultLifetimeSetting(value)
    setSetting(value)
  }

  return (
    <div className="mt-4">
      <h3 className="text-sm text-neutral-400">Message lifetime</h3>
      <p className="text-sm text-neutral-500 mt-1">
        The lifetime the composer starts with when you open a conversation. You can still change it for individual messages.
      </p>
      <label className="flex items-center gap-2 mt-2 text-sm text-neutral-400">
        Default message lifetime
        <select
          value={setting === null ? REMEMBER_LAST : setting}
          onChange={handleChange}
          aria-label="Default message lifetime"
          className="text-sm"
        >
          <option value={REMEMBER_LAST}>Remember last selection</option>
          {MESSAGE_LIFETIMES.map((o) => <option key={o.seconds} value={o.seconds}>{o.label}</option>)}
        </select>
      </label>
    </div>
  )
}
