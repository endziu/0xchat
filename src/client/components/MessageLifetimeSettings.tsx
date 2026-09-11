import { useState } from 'preact/hooks'
import { getDefaultLifetimeSetting, setDefaultLifetimeSetting } from '../lib/message-lifetime'
import { LifetimeOptions } from './LifetimeOptions'

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
    <section className="border-t border-neutral-800 p-3">
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm uppercase tracking-wider text-neutral-500">Message lifetime</span>
        <select
          value={setting === null ? REMEMBER_LAST : setting}
          onChange={handleChange}
          aria-label="Default message lifetime"
          className="max-w-[65%] text-sm"
        >
          <option value={REMEMBER_LAST}>Remember last</option>
          <LifetimeOptions />
        </select>
      </label>
    </section>
  )
}
