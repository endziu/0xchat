import { useEffect, useRef, useState } from 'preact/hooks'
import type { Keypair } from '../lib/burner'
import { Check, Copy, Flame, X } from 'lucide-preact'
import { KeyManagement } from './KeyManagement'
import { MessageLifetimeSettings } from './MessageLifetimeSettings'
import { Modal } from './Modal'
import { AddressQR } from './QRModal'
import { useCopied } from '../hooks/useCopied'
import { version } from '../../../package.json'

export interface PushSettings {
  supported?: boolean
  subscribed?: boolean
  permission?: NotificationPermission | null
  error?: string | null
  subscribe?: () => void
  unsubscribe?: () => void
}

interface SettingsModalProps {
  identity: Keypair
  onClose: () => void
  onImport: (keypair: Keypair) => Promise<void>
  push?: PushSettings
  // Permanently deletes the identity, its account and its messages.
  onBurn?: () => void
}

export function SettingsModal({
  identity,
  onClose,
  onImport,
  push,
  onBurn,
}: SettingsModalProps) {
  const {
    supported: pushSupported,
    subscribed: pushSubscribed,
    permission: pushPermission,
    error: pushError,
    subscribe: onPushSubscribe,
    unsubscribe: onPushUnsubscribe,
  } = push ?? {}
  const [copied, copy] = useCopied()
  const [burnConfirm, setBurnConfirm] = useState(false)
  const burnTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(burnTimeout.current), [])
  // Focus the safe choice, which also scrolls the confirmation into view.
  const cancelBurnRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (burnConfirm) cancelBurnRef.current?.focus() }, [burnConfirm])

  const askBurn = () => {
    setBurnConfirm(true)
    burnTimeout.current = setTimeout(() => setBurnConfirm(false), 8000)
  }
  const cancelBurn = () => { clearTimeout(burnTimeout.current); setBurnConfirm(false) }

  return (
    <Modal onClose={onClose} labelledBy="settings-title" className="max-w-lg">
      <header className="flex items-center justify-between border-b border-neutral-800 p-2">
        <div className="flex items-baseline gap-2">
          <h2 id="settings-title">Settings</h2>
          <span className="text-xs text-neutral-500">v{version}</span>
        </div>
        <button onClick={onClose} aria-label="Close settings" title="Close">
          <X size={16} />
        </button>
      </header>

      <div className="min-h-0 overflow-y-auto">
        <section className="p-3">
          <h3>Profile</h3>
          <div className="mt-2 flex flex-col items-center gap-1">
            <AddressQR address={identity.address} size={160} />
            <button
              onClick={() => copy(identity.address)}
              className="text-sm"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />} Copy address
            </button>
          </div>
        </section>

        <MessageLifetimeSettings />

        {pushSupported && (
          <section className="border-t border-neutral-800 p-3">
            <h3>Notifications</h3>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span id="notifications-label" className="text-sm text-neutral-400">Notify me of new messages</span>
              {pushPermission !== 'denied' && (
                <button
                  role="switch"
                  aria-checked={!!pushSubscribed}
                  aria-labelledby="notifications-label"
                  onClick={pushSubscribed ? onPushUnsubscribe : onPushSubscribe}
                  className="shrink-0 rounded-full border-0 p-0"
                >
                  {/* Keep the visual track independent of the button's 44px touch target. */}
                  <span aria-hidden="true" className={`inline-flex h-6 w-11 box-border items-center rounded-full border p-0.5 ${pushSubscribed ? 'border-accent' : 'border-neutral-800'}`}>
                    <span className={`block h-4 w-4 shrink-0 rounded-full transition-transform ${pushSubscribed ? 'translate-x-5 bg-accent' : 'bg-neutral-500'}`} />
                  </span>
                </button>
              )}
            </div>
            {pushPermission === 'denied' && (
              <p className="mt-2 text-sm">
                Blocked in this browser. To allow notifications, open this site's settings
                (usually the icon beside the address bar), allow Notifications, then reload.
              </p>
            )}
            {pushError && <p className="mt-2 text-sm text-red-400">{pushError}</p>}
          </section>
        )}

        <KeyManagement identity={identity} onImport={onImport} />

        {onBurn && (
          <section className="border-t border-red-900 p-3">
            <h3 className="text-red-400">Danger zone</h3>
            {burnConfirm ? (
              <div role="alert" className="mt-2">
                <p className="text-sm text-red-400">
                  This permanently deletes your identity, account, and all messages. This cannot be undone.
                </p>
                <div className="mt-2 flex gap-1">
                  <button onClick={onBurn} className="text-sm text-red-400 border-red-900">Burn</button>
                  <button ref={cancelBurnRef} onClick={cancelBurn} className="text-sm">Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={askBurn} className="mt-2 text-sm text-red-400 border-red-900">
                <Flame size={14} /> Burn identity…
              </button>
            )}
          </section>
        )}
      </div>
    </Modal>
  )
}
