import { useState } from 'preact/hooks'
import { ChevronRight } from 'lucide-preact'
import { getDefaultLifetimeSetting, MESSAGE_LIFETIMES, setDefaultLifetimeSetting } from '../lib/message-lifetime'
import { LifetimeOptions } from './LifetimeOptions'
import { ROW, SettingsGroup } from './SettingsGroup'

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
    <SettingsGroup title="Messages" foot="How long your messages last after they’re opened. Unopened messages are deleted after 24 hours.">
      {/* The row is what shows; the real select lies invisibly on top of it,
          so taps still open the native picker. */}
      <label className={`${ROW} cursor-pointer hover:bg-raised/50 has-[select:focus-visible]:outline-2 has-[select:focus-visible]:-outline-offset-2 has-[select:focus-visible]:outline-accent`}>
        <span className="flex-1">Message lifetime</span>
        <span aria-hidden="true" className="inline-flex items-center gap-0.5 text-text-2">
          {setting === null ? 'Remember last' : MESSAGE_LIFETIMES.find(o => o.seconds === setting)?.label}
          <ChevronRight size={18} />
        </span>
        <select
          value={setting === null ? REMEMBER_LAST : setting}
          onChange={handleChange}
          aria-label="Default message lifetime"
          className="absolute inset-0 min-h-0 opacity-0"
        >
          <option value={REMEMBER_LAST}>Remember last</option>
          <LifetimeOptions />
        </select>
      </label>
    </SettingsGroup>
  )
}
