import { useEffect, useState } from 'preact/hooks'
import { getThemeSetting, resolvedTheme, subscribeTheme } from '../lib/theme'

/** The theme setting and the theme it currently resolves to, kept live. */
export function useTheme() {
  const read = () => ({ setting: getThemeSetting(), theme: resolvedTheme() })
  const [state, setState] = useState(read)
  useEffect(() => subscribeTheme(() => setState(read())), [])
  return state
}
