import type { ComponentChildren } from 'preact'
import { useState, useRef, useEffect } from 'preact/hooks'
import type { Keypair } from '../lib/burner'
import { LogOut, Settings, Copy, Check, Link, QrCode } from 'lucide-preact'
import { KeyManagement } from './KeyManagement'
import { InstallBanner } from './InstallBanner'
import { QRModal } from './QRModal'
import { useToast } from './Toast'
import { version } from '../../../package.json'

interface LayoutProps {
  children: ComponentChildren
  identity: Keypair | null
  onLogout: () => void
  onImport?: (keypair: Keypair) => Promise<void>
  navigate?: (to: string) => void
  error?: string | null
  sseConnected?: boolean
  pushSupported?: boolean
  pushSubscribed?: boolean
  pushPermission?: NotificationPermission | null
  pushError?: string | null
  onPushSubscribe?: () => void
  onPushUnsubscribe?: () => void
}

export function Layout({
  children,
  identity,
  onLogout,
  onImport,
  navigate,
  error,
  sseConnected,
  pushSupported,
  pushSubscribed,
  pushPermission,
  pushError,
  onPushSubscribe,
  onPushUnsubscribe,
}: LayoutProps) {
  const { toast } = useToast()
  const [showSettings, setShowSettings] = useState(false)
  const [copied, setCopied] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const [logoutConfirm, setLogoutConfirm] = useState(false)
  const [showQR, setShowQR] = useState(false)
  const logoutTimeoutRef = useRef<any>(null)
  const prevConnected = useRef<boolean | undefined>(undefined)

  useEffect(() => {
    return () => { if (logoutTimeoutRef.current) clearTimeout(logoutTimeoutRef.current) }
  }, [])

  useEffect(() => {
    if (prevConnected.current === true && sseConnected === false) {
      toast('Connection lost — messages may be delayed', 'error')
    } else if (prevConnected.current === false && sseConnected === true) {
      toast('Reconnected', 'info')
    }
    prevConnected.current = sseConnected
  }, [sseConnected, toast])

  const dismissLogoutConfirm = () => {
    if (logoutTimeoutRef.current) clearTimeout(logoutTimeoutRef.current)
    setLogoutConfirm(false)
  }

  const handleCopy = () => {
    if (!identity) return
    navigator.clipboard.writeText(identity.address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    // Inset the whole shell rather than each bar: index.html opts into
    // viewport-fit=cover, so the notch and home indicator are ours to avoid.
    <div className="flex flex-col h-dvh max-w-[56.25rem] mx-auto border-x border-neutral-800 safe-top safe-bottom safe-x">
      {error && <div className="p-2 text-center text-neutral-500 border-b border-neutral-800">{error}</div>}
      <header className="flex items-center justify-between p-2 border-b border-neutral-800 shrink-0 gap-2">
        <div className="flex items-center gap-2">
          <a href="/chat" onClick={(e) => { e.preventDefault(); navigate?.('/chat') }} className="whitespace-nowrap">⬡ 0xChat</a>
          {sseConnected !== undefined && (
            <span className="flex items-center gap-1 text-neutral-600 text-sm" title={sseConnected ? 'Live' : 'Connecting'}>
              <span className={`w-1.5 h-1.5 rounded-full ${sseConnected ? 'bg-green-400' : 'bg-neutral-700'}`} />
              {/* The dot alone carries the state; the word is header width we
                  can't spare next to 44px touch targets. */}
              <span className="max-sm:hidden">{sseConnected ? 'Live' : '...'}</span>
            </span>
          )}
        </div>
        {identity && (
          <div className="flex items-center gap-2 max-sm:gap-0 text-sm text-neutral-500">
            <span className="max-sm:hidden">{identity.address.slice(0, 6)}...{identity.address.slice(-4)}</span>
            <button onClick={handleCopy} title="Copy Address" aria-label="Copy address" className="header-action">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            <button onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/chat/${identity.address}`); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000) }} title="Copy conversation link" aria-label="Copy conversation link" className="header-action">
              {linkCopied ? <Check size={14} /> : <Link size={14} />}
            </button>
            <button onClick={() => setShowQR(true)} title="Show QR code" aria-label="Show QR code" className="header-action">
              <QrCode size={14} />
            </button>
            <button onClick={() => setShowSettings(!showSettings)} title="Settings" aria-label="Settings" aria-expanded={showSettings} className="header-action">
              <Settings size={14} />
            </button>
            <div className="relative">
              <button
                onClick={() => {
                  if (logoutConfirm) {
                    dismissLogoutConfirm()
                    return
                  }
                  setLogoutConfirm(true)
                  logoutTimeoutRef.current = setTimeout(() => setLogoutConfirm(false), 8000)
                }}
                title={logoutConfirm ? 'Cancel' : 'Burn identity'}
                aria-label={logoutConfirm ? 'Cancel' : 'Burn identity'}
                aria-expanded={logoutConfirm}
                className={`header-action ${logoutConfirm ? 'text-red-400' : ''}`}
              >
                <LogOut size={14} />
              </button>
              {logoutConfirm && (
                <div role="alertdialog" aria-live="assertive" className="absolute right-0 top-full mt-1 z-10 w-72 bg-black border border-red-900 p-2 text-left">
                  <p className="text-sm text-red-400">
                    This permanently deletes your identity, account, and all messages. This cannot be undone.
                  </p>
                  <div className="flex gap-1 mt-2">
                    <button
                      onClick={() => {
                        dismissLogoutConfirm()
                        setShowSettings(true)
                      }}
                      className="text-sm whitespace-nowrap"
                    >
                      Export
                    </button>
                    <button onClick={onLogout} className="text-sm text-red-400 whitespace-nowrap">
                      Burn
                    </button>
                    <button onClick={dismissLogoutConfirm} className="text-sm whitespace-nowrap">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </header>
      <InstallBanner />
      <main className="flex-1 overflow-hidden flex flex-col">
        {showSettings && identity && (
          <section className="p-3 border-b border-neutral-800">
            <div className="flex justify-between items-center">
              <h2>Identity</h2>
              <button onClick={() => setShowSettings(false)}>Close</button>
            </div>
            <KeyManagement
              identity={identity}
              onImport={async (keypair) => {
                await onImport?.(keypair)
                setShowSettings(false)
              }}
            />
            {pushSupported && (
              <div className="mt-4">
                <h3 className="text-sm text-neutral-400">Notifications</h3>
                <p className="text-sm text-neutral-500 mt-1">
                  Get an alert on this device when a new message arrives. No message content or contact info is ever sent through the notification — just a wakeup.
                </p>
                {pushPermission === 'denied' ? (
                  <p className="text-sm text-neutral-500 mt-2">Notifications blocked — enable them in your browser/OS settings.</p>
                ) : (
                  <button
                    className="mt-2 min-w-[44px] min-h-[44px]"
                    onClick={pushSubscribed ? onPushUnsubscribe : onPushSubscribe}
                  >
                    {pushSubscribed ? 'Disable notifications' : 'Enable notifications'}
                  </button>
                )}
                {pushError && <p className="text-sm text-red-400 mt-2">{pushError}</p>}
              </div>
            )}
          </section>
        )}
        {children}
      </main>
      <div className="fixed bottom-1 left-1 max-sm:bottom-auto max-sm:left-auto max-sm:top-1 max-sm:right-1 z-20 text-[0.625rem] leading-3 text-neutral-700 pointer-events-none" aria-label={`Version ${version}`}>
        v{version}
      </div>
      {showQR && identity && (
        <QRModal
          mode="show"
          address={identity.address}
          onClose={() => setShowQR(false)}
          onScan={(addr) => { setShowQR(false); navigate?.(`/chat/${addr.toLowerCase()}`) }}
        />
      )}
    </div>
  )
}
