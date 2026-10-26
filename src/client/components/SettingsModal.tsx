import { checksumAddress } from '../../shared/address'
import { conversationUrl } from '../lib/address-links'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Keypair } from '../../shared/keypair'
import { Check, Copy, Flame, Link, QrCode } from 'lucide-preact'
import { AddressAvatar } from './AddressAvatar'
import { AddressHex } from './AddressHex'
import { KeyManagement } from './KeyManagement'
import { MessageLifetimeSettings } from './MessageLifetimeSettings'
import { Modal } from './Modal'
import { Segmented } from './Segmented'
import { ROW, SettingsGroup } from './SettingsGroup'
import { useTheme } from '../hooks/useTheme'
import { setThemeSetting, type ThemeSetting } from '../lib/theme'
import { useCopied } from '../hooks/useCopied'
import { version } from '../../../package.json'

const THEME_OPTIONS: { value: ThemeSetting; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

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
  // Opens the share sheet with your QR code.
  onShare?: () => void
  push: PushSettings
  // Permanently deletes the identity, its account and its messages.
  onBurn?: () => void
}

export function SettingsModal({
  identity,
  onClose,
  onImport,
  onShare,
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
  } = push
  const [copied, copy] = useCopied()
  const [linkCopied, copyLink] = useCopied()
  const { setting: themeSetting } = useTheme()
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
    <Modal onClose={onClose} title="Settings">
      <div className="min-h-0 overflow-y-auto px-4 pt-1 pb-[max(24px,env(safe-area-inset-bottom))]">
        <section className="grid justify-items-center gap-3 px-2 pt-3 pb-1 text-center">
          <AddressAvatar address={identity.address} size={64} />
          <AddressHex address={identity.address} className="max-w-[22ch]" />
          <div className="flex flex-wrap justify-center gap-2">
            <button onClick={() => copy(checksumAddress(identity.address))} className="btn">
              {copied ? <Check size={16} /> : <Copy size={16} />}Copy address
            </button>
            <button onClick={() => copyLink(conversationUrl(identity.address))} className="btn">
              {linkCopied ? <Check size={16} /> : <Link size={16} />}Copy link
            </button>
            <button onClick={onShare} className="btn"><QrCode size={16} />QR code</button>
          </div>
        </section>

        <SettingsGroup title="Appearance" foot="System follows your device’s light or dark setting.">
          <div className="p-2">
            <Segmented label="Theme" value={themeSetting} onChange={setThemeSetting} options={THEME_OPTIONS} />
          </div>
        </SettingsGroup>

        <MessageLifetimeSettings />

        {pushSupported && (
          <SettingsGroup
            title="Notifications"
            foot={<>
              {pushPermission === 'denied'
                ? <p>Blocked in this browser. To allow notifications, open this site's settings (usually the icon beside the address bar), allow Notifications, then reload.</p>
                : <p>Alerts never include message text or who sent it.</p>}
              {pushError && <p className="mt-1 text-danger">{pushError}</p>}
            </>}
          >
            <div className={ROW}>
              <span id="notifications-label" className="flex-1">Notify me of new messages</span>
              {pushPermission === 'denied' ? <span className="mr-2 text-text-2">Blocked</span> : (
                <button
                  role="switch"
                  aria-checked={!!pushSubscribed}
                  aria-labelledby="notifications-label"
                  onClick={pushSubscribed ? onPushUnsubscribe : onPushSubscribe}
                  className="mr-1.5 shrink-0 justify-center rounded-full"
                >
                  {/* Keep the visual track independent of the button's 44px touch target. */}
                  <span aria-hidden="true" className={`relative block h-8 w-13 rounded-full ${pushSubscribed ? 'bg-accent' : 'bg-line-strong'}`}>
                    <span className={`absolute top-[3px] left-[3px] size-[26px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/.2)] transition-transform motion-reduce:transition-none ${pushSubscribed ? 'translate-x-5' : ''}`} />
                  </span>
                </button>
              )}
            </div>
          </SettingsGroup>
        )}

        <KeyManagement identity={identity} onImport={onImport} />

        {onBurn && (
          <SettingsGroup className="mt-6" foot="Deletes this account, its key and every message, for good.">
            {burnConfirm ? (
              <div role="alert" className="grid justify-items-center gap-3 px-4 py-5 text-center text-danger">
                <Flame size={22} />
                <p className="text-text">This permanently deletes your identity, account, and all messages. This cannot be undone.</p>
                <button onClick={onBurn} className="btn btn-danger-fill btn-lg">Burn</button>
                <button ref={cancelBurnRef} onClick={cancelBurn} className="btn btn-lg">Cancel</button>
              </div>
            ) : (
              <button onClick={askBurn} className={`${ROW} justify-center font-bold text-danger hover:bg-raised/50`}>Burn identity…</button>
            )}
          </SettingsGroup>
        )}

        <p className="mt-6 text-center text-xs text-text-3">
          hushhash {version} · <a href="/docs/" target="_blank" rel="noopener" className="underline">Help and docs</a>
        </p>
      </div>
    </Modal>
  )
}
