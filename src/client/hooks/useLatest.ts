import { useCallback, useLayoutEffect, useRef } from 'preact/hooks'

/**
 * Returns a stable function that always invokes the latest `fn`.
 *
 * Write the handler body once. The returned identity never changes, so
 * effects keyed on it (e.g. useSSE) don't re-run on every render. The ref is
 * refreshed in a layout effect (synchronously after commit) so an event that
 * lands right after a render always sees the latest closure, not the previous
 * one a passive effect would leave behind.
 */
export function useLatest<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback(((...args: Parameters<T>) => ref.current(...args)) as T, [])
}
