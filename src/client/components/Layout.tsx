import { conversationPath } from '../lib/address-links'
import { checksumAddress, shortAddress } from '../../shared/address'
import type { ComponentChildren } from 'preact'
import { useState, useEffect } from 'preact/hooks'
import type { Keypair } from '../lib/burner'
import { Settings, Copy, Check, Link, QrCode } from 'lucide-preact'
import { AddressAvatar } from './AddressAvatar'
import { InstallBanner } from './InstallBanner'
import { QRModal } from './QRModal'
import { SettingsModal } from './SettingsModal'
import { useCopied } from '../hooks/useCopied'
import type { PushSettings } from './SettingsModal'

interface LayoutProps {
  children: ComponentChildren
  identity: Keypair | null
  onLogout: () => void
  onImport?: (keypair: Keypair) => Promise<void>
  navigate?: (to: string) => void
  error?: string | null
  sseConnected?: boolean
  push?: PushSettings
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
  const [copied, copy] = useCopied()
  const [linkCopied, copyLink] = useCopied()
  const [showQR, setShowQR] = useState(false)
  // The first connection is not a reconnection: before it, the dot alone says
  // "connecting". After it, a lost stream gets a strip that stays until it is back.
  const [everConnected, setEverConnected] = useState(false)
  useEffect(() => { if (sseConnected) setEverConnected(true) }, [sseConnected])
  const reconnecting = everConnected && sseConnected === false

  return (
    // index.html opts into viewport-fit=cover, so the notch and home indicator
    // are ours to avoid. The shell insets the top and sides; the bottom inset
    // is left to whatever sits there (composer, conversation list) so it isn't
    // stacked on top of their own padding. h-full, not h-dvh: see styles.css.
    // No side borders on phones: they'd sit on the screen edge, clipped by its curve.
    <div className="flex flex-col h-full max-w-[56.25rem] mx-auto border-x border-neutral-800 max-sm:border-x-0 safe-top safe-x">
      {error && <div className="p-2 text-center text-neutral-500 border-b border-neutral-800">{error}</div>}
      <header className="flex items-center justify-between min-h-11 px-2 sm:py-2 border-b border-neutral-800 shrink-0 gap-2">
        <div className="flex items-center gap-2">
          <a href="/chat" onClick={(e) => { e.preventDefault(); navigate?.('/chat') }} className="flex items-center gap-2 whitespace-nowrap">
            {/* Phones have no room for the identity beside the buttons, so its
                glyph takes the hexagon's place by the title. It matches the
                conversation list's glyphs and sits in their column: a row's
                pl-1, unread dot and gap-2 put them 10px right of our px-2. */}
            {identity && <span className="flex sm:hidden ml-2.5"><AddressAvatar address={identity.address} /></span>}
            <span className={identity ? 'max-sm:hidden' : undefined}>⬡</span>
            0xChat
          </a>
          {sseConnected !== undefined && (
            <span className="flex items-center gap-1 text-neutral-500 text-sm" title={sseConnected ? 'Live' : 'Connecting'}>
              <span className={`w-1.5 h-1.5 rounded-full ${sseConnected ? 'bg-green-400' : 'bg-neutral-700'}`} />
              {/* The dot alone carries the state; the word is header width we
                  can't spare next to 44px touch targets. */}
              <span className="max-sm:hidden">{sseConnected ? 'Live' : '...'}</span>
            </span>
          )}
        </div>
        {identity && (
          <div className="flex items-center gap-2 max-sm:gap-1 text-sm text-neutral-500">
            {/* On phones the glyph moves beside the title. Text sits above its
                line box's centre, so the pair moves down onto the buttons' centre. */}
            <span className="flex items-center gap-2 translate-y-[0.05em] max-sm:hidden">
              <AddressAvatar address={identity.address} size={20} />
              <span>{shortAddress(identity.address)}</span>
            </span>
            <button onClick={() => copy(checksumAddress(identity.address))} title="Copy Address" aria-label="Copy address" className="header-action">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            <button onClick={() => copyLink(`${window.location.origin}${conversationPath(identity.address)}`)} title="Copy conversation link" aria-label="Copy conversation link" className="header-action">
              {linkCopied ? <Check size={14} /> : <Link size={14} />}
            </button>
            <button onClick={() => setShowQR(true)} title="Show QR code" aria-label="Show QR code" className="header-action">
              <QrCode size={14} />
            </button>
            <button onClick={() => setShowSettings(!showSettings)} title="Settings" aria-label="Settings" aria-expanded={showSettings} className="header-action">
              <Settings size={14} />
            </button>
          </div>
        )}
      </header>
      {reconnecting && (
        <div role="status" className="px-2 py-0.5 text-center text-xs text-neutral-400 bg-neutral-900 border-b border-neutral-800">Reconnecting…</div>
      )}
      <InstallBanner />
      <main className="flex-1 overflow-hidden flex flex-col">
        {children}
      </main>
      {showSettings && identity && (
        <SettingsModal
          identity={identity}
          onClose={() => setShowSettings(false)}
          onImport={async (keypair) => {
            await onImport?.(keypair)
            setShowSettings(false)
          }}
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
