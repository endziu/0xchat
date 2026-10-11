import { conversationPath } from '../lib/address-links'
import { shortAddress } from '../../shared/address'
import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import type { Keypair } from '../../shared/keypair'
import { Settings, QrCode, CircleHelp } from 'lucide-preact'
import { AddressAvatar } from './AddressAvatar'
import { InstallBanner } from './InstallBanner'
import { QRModal } from './QRModal'
import { SettingsModal } from './SettingsModal'
import type { PushSettings } from './SettingsModal'

// What the shell hands the chat view: the identity bar for the top of the
// chats panel, and a way to open the share sheet.
export interface Chrome {
  sidebarTop: ComponentChildren
  openShare: () => void
}

interface LayoutProps {
  children: (chrome: Chrome) => ComponentChildren
  identity: Keypair | null
  onLogout: () => void
  onImport?: (keypair: Keypair) => Promise<void>
  navigate?: (to: string) => void
  error?: string | null
  sseConnected: boolean
  push: PushSettings
}

export function Layout({
  children,
  identity,
  onLogout,
  onImport,
  navigate,
  error,
  sseConnected,
  push,
}: LayoutProps) {
  const [showSettings, setShowSettings] = useState(false)
  const [showQR, setShowQR] = useState(false)
  const openShare = () => setShowQR(true)
  const status = sseConnected ? 'Live' : 'Connecting'

  const sidebarTop = identity && (
    <>
      <div className="flex shrink-0 items-center gap-0.5 pt-2 pr-2 pl-3">
        <button onClick={openShare} title={status} aria-label={`Your address ${shortAddress(identity.address)}, ${status}`} className="relative gap-2.5 rounded-md py-1 pr-2.5 pl-1 hover:bg-raised">
          <AddressAvatar address={identity.address} size={32} />
          <span className="grid text-left leading-tight max-sm:hidden">
            <b className="font-bold">0xChat</b>
            <small className="font-mono text-xs text-text-3">{shortAddress(identity.address)}</small>
          </span>
          <span aria-hidden="true" className={`absolute top-[26px] left-7 size-2.5 rounded-full border-2 border-surface ${sseConnected ? 'bg-ok' : 'bg-text-3'}`} />
        </button>
        <span className="flex-1" />
        <button onClick={openShare} title="Share your address" aria-label="Share your address" className="icon-btn"><QrCode size={20} /></button>
        <button onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings" aria-expanded={showSettings} className="icon-btn"><Settings size={20} /></button>
        {/* Open separately so help does not replace the installed app. */}
        <a href="/docs/" target="_blank" rel="noopener" title="Help & docs" aria-label="Help & docs" className="icon-btn inline-flex items-center">
          <CircleHelp size={20} />
        </a>
      </div>
      <InstallBanner />
    </>
  )

  return (
    // index.html opts into viewport-fit=cover, so the notch and home indicator
    // are ours to avoid. The shell insets the top and sides; the bottom inset
    // is left to whatever sits there (composer, conversation list) so it isn't
    // stacked on top of their own padding. h-full, not h-dvh: see styles.css.
    <div className="mx-auto flex h-full max-w-[90rem] flex-col safe-top safe-x sm:p-3">
      {error && <div role="alert" className="mb-2 rounded-md bg-raised p-2 text-center text-sm text-danger">{error}</div>}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children({ sidebarTop, openShare })}
      </main>
      {showSettings && identity && (
        <SettingsModal
          identity={identity}
          onClose={() => setShowSettings(false)}
          onImport={async (keypair) => {
            await onImport?.(keypair)
            setShowSettings(false)
          }}
          onShare={() => { setShowSettings(false); openShare() }}
          push={push}
          onBurn={onLogout}
        />
      )}
      {showQR && identity && (
        <QRModal
          mode="show"
          address={identity.address}
          onClose={() => setShowQR(false)}
          onScan={(addr) => { setShowQR(false); navigate?.(conversationPath(addr)) }}
        />
      )}
    </div>
  )
}
