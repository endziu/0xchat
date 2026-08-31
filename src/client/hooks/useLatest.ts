import { useCallback, useEffect, useRef } from 'preact/hooks'

/**
 * Returns a stable function that always invokes the latest `fn`.
 *
 * Write the handler body once. The returned identity never changes, so
 * effects keyed on it (e.g. useSSE) don't re-run on every render.
 */
export function useLatest<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  })
  return useCallback(((...args: Parameters<T>) => ref.current(...args)) as T, [])
}
