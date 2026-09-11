import { useEffect, useState } from 'preact/hooks'

/**
 * A visible document in a focused window. Background tabs, minimized apps and
 * locked phones do not count, even while SSE stays connected.
 */
export function isWindowAttentive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** Re-renders when the window gains or loses attention. */
export function useWindowAttention(): boolean {
  const [attentive, setAttentive] = useState(isWindowAttentive)
  useEffect(() => {
    const update = () => setAttentive(isWindowAttentive())
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    update()
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])
  return attentive
}
