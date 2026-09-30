import { X, Share, SquarePlus } from 'lucide-preact'
import { useInstallPrompt } from '../hooks/useInstallPrompt'

export function InstallBanner() {
  const { mode, install, dismiss } = useInstallPrompt()
  if (!mode) return null

  return (
    <aside className="flex items-center gap-2 px-2 py-1.5 border-b border-neutral-800 bg-neutral-950 shrink-0">
      {mode === 'prompt' ? (
        <>
          <span className="flex-1 min-w-0 text-sm text-neutral-500 truncate">Install 0xChat as an app</span>
          <button onClick={install} className="shrink-0">⬡ Install</button>
        </>
      ) : (
        <span className="flex-1 min-w-0 text-sm text-neutral-500 flex items-center gap-1 flex-wrap">
          To Install go to Page Menu (⋯) →{' '}
          <span className="inline-flex items-center gap-1">Share <Share size={13} aria-hidden="true" className="shrink-0" /></span>
          →{' '}
          <span className="inline-flex items-center gap-1">Add to Home Screen <SquarePlus size={13} aria-hidden="true" className="shrink-0" /></span>
        </span>
      )}
      <button onClick={dismiss} aria-label="Dismiss" className="border-0 shrink-0"><X size={14} /></button>
    </aside>
  )
}
