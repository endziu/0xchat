import { X, Share, SquarePlus } from 'lucide-preact'
import { useInstallPrompt } from '../hooks/useInstallPrompt'

export function InstallBanner() {
  const { mode, install, dismiss } = useInstallPrompt()
  if (!mode) return null

  return (
    <aside className="mx-3 mt-2 flex shrink-0 items-center gap-2 rounded-md bg-raised py-2.5 pr-1.5 pl-4">
      {mode === 'prompt' ? (
        <>
          <b className="min-w-0 flex-1 font-bold">Install hushhash as an app</b>
          <button onClick={install} className="btn btn-accent shrink-0">Install</button>
        </>
      ) : (
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm text-text-2">
          To Install go to Page Menu (⋯) →{' '}
          <span className="inline-flex items-center gap-1">Share <Share size={13} aria-hidden="true" className="shrink-0" /></span>
          →{' '}
          <span className="inline-flex items-center gap-1">Add to Home Screen <SquarePlus size={13} aria-hidden="true" className="shrink-0" /></span>
        </span>
      )}
      <button onClick={dismiss} aria-label="Dismiss" className="icon-btn"><X size={18} /></button>
    </aside>
  )
}
