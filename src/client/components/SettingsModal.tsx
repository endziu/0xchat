import { useEffect } from 'preact/hooks'
import type { Keypair } from '../lib/burner'
import { X } from 'lucide-preact'
import { KeyManagement } from './KeyManagement'
import { MessageLifetimeSettings } from './MessageLifetimeSettings'

interface SettingsModalProps {
  identity: Keypair
  onClose: () => void
  onImport: (keypair: Keypair) => Promise<void>
  pushSupported?: boolean
  pushSubscribed?: boolean
  pushPermission?: NotificationPermission | null
  pushError?: string | null
  onPushSubscribe?: () => void
  onPushUnsubscribe?: () => void
}

export function SettingsModal({
  identity,
  onClose,
  onImport,
  pushSupported,
  pushSubscribed,
  pushPermission,
  pushError,
  onPushSubscribe,
  onPushUnsubscribe,
}: SettingsModalProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex max-h-full w-full max-w-lg flex-col border border-neutral-800 bg-black"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-neutral-800 p-2">
          <h2 id="settings-title">Settings</h2>
          <button onClick={onClose} aria-label="Close settings" title="Close">
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto">
          <KeyManagement identity={identity} onImport={onImport} />
          <MessageLifetimeSettings />

          {pushSupported && (
            <section className="border-t border-neutral-800 p-3">
              <div className="flex items-center justify-between gap-3">
                <h3>Notifications</h3>
                {pushPermission === 'denied' ? (
                  <span className="text-sm text-neutral-600">Blocked</span>
                ) : (
                  <button
                    onClick={pushSubscribed ? onPushUnsubscribe : onPushSubscribe}
                    aria-label={pushSubscribed ? 'Disable notifications' : 'Enable notifications'}
                    aria-pressed={pushSubscribed}
                  >
                    {pushSubscribed ? 'On' : 'Off'}
                  </button>
                )}
              </div>
              {pushError && <p className="mt-2 text-sm text-red-400">{pushError}</p>}
            </section>
          )}
        </div>
      </section>
    </div>
  )
}
