import { useEffect } from 'preact/hooks'
import type { Keypair } from '../lib/burner'
import { X } from 'lucide-preact'
import { KeyManagement } from './KeyManagement'
import { MessageLifetimeSettings } from './MessageLifetimeSettings'
import type { PushSlotSummary } from '../../shared/push-slot'

export interface PushSettings {
  supported?: boolean
  subscribed?: boolean
  removable?: boolean
  slots?: PushSlotSummary[]
  permission?: NotificationPermission | null
  error?: string | null
  subscribe?: () => void
  unsubscribe?: () => void
  removeSlot?: (slot: PushSlotSummary) => void
}

interface SettingsModalProps {
  identity: Keypair
  onClose: () => void
  onImport: (keypair: Keypair) => Promise<void>
  push?: PushSettings
}

export function SettingsModal({
  identity,
  onClose,
  onImport,
  push,
}: SettingsModalProps) {
  const {
    supported: pushSupported,
    subscribed: pushSubscribed,
    removable: pushRemovable,
    slots: pushSlots,
    permission: pushPermission,
    error: pushError,
    subscribe: onPushSubscribe,
    unsubscribe: onPushUnsubscribe,
    removeSlot: onPushRemoveSlot,
  } = push ?? {}

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

          {(pushSupported || (pushSlots?.length ?? 0) > 0) && (
            <section className="border-t border-neutral-800 p-3">
              <div className="flex items-center justify-between gap-3">
                <h3>Notifications</h3>
                {!pushSupported ? (
                  <span className="text-sm text-neutral-600">Unavailable here</span>
                ) : pushPermission === 'denied' ? (
                  <span className="text-sm text-neutral-600">Blocked</span>
                ) : pushSubscribed ? (
                  <button
                    onClick={onPushUnsubscribe}
                    aria-label="Disable notifications"
                    aria-pressed={true}
                  >
                    On
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    {pushRemovable && (
                      <button onClick={onPushUnsubscribe} aria-label="Remove notification slot">
                        Remove
                      </button>
                    )}
                    <button
                      onClick={onPushSubscribe}
                      aria-label="Enable notifications"
                      aria-pressed={false}
                    >
                      Off
                    </button>
                  </div>
                )}
              </div>
              {pushSlots && pushSlots.length > 0 && (
                <div className="mt-3 border-t border-neutral-800 pt-3">
                  <h4 className="text-sm">Notification subscriptions</h4>
                  <ul className="mt-2 space-y-2 text-sm">
                    {pushSlots.map(slot => (
                      <li key={slot.slot_id} className="flex items-center justify-between gap-2">
                        <div>
                          <div>{slot.label} · {slot.state === 'active' ? 'Active' : 'Needs repair'}</div>
                          <div className="text-xs text-neutral-600">Slot {slot.slot_id} · updated {new Date(slot.updated_at).toLocaleString()}</div>
                        </div>
                        <button onClick={() => onPushRemoveSlot?.(slot)} aria-label={`Remove notification slot ${slot.slot_id}`}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {pushError && <p className="mt-2 text-sm text-red-400">{pushError}</p>}
            </section>
          )}
        </div>
      </section>
    </div>
  )
}
