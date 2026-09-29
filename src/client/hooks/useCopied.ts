import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

/**
 * Copies text to the clipboard and reports `copied` for two seconds, so a
 * button can show a check mark. The reset is cancelled on unmount.
 */
export function useCopied(): [copied: boolean, copy: (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timeout.current), [])
  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    clearTimeout(timeout.current)
    timeout.current = setTimeout(() => setCopied(false), 2000)
  }, [])
  return [copied, copy]
}
