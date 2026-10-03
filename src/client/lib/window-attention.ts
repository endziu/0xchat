/**
 * A visible document in a focused window. Background tabs, minimized apps and
 * locked phones do not count, even while SSE stays connected.
 */
export function isWindowAttentive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** Calls `listener` with the window's attention on every focus or visibility event; returns the unsubscribe function. */
export function watchWindowAttention(listener: (attentive: boolean) => void): () => void {
  const update = () => listener(isWindowAttentive())
  document.addEventListener('visibilitychange', update)
  window.addEventListener('focus', update)
  window.addEventListener('blur', update)
  return () => {
    document.removeEventListener('visibilitychange', update)
    window.removeEventListener('focus', update)
    window.removeEventListener('blur', update)
  }
}
