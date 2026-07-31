import { ComponentChildren } from 'preact'
import { useState, useRef, useEffect } from 'preact/hooks'
import { Keypair } from '../lib/burner'
import { LogOut, Settings, Copy, Check, Link, QrCode } from 'lucide-preact'
import { KeyManagement } from './KeyManagement'
import { InstallBanner } from './InstallBanner'
import { QRModal } from './QRModal'
import { useToast } from './Toast'

interface LayoutProps {
  children: ComponentChildren
  identity: Keypair | null
  onLogout: () => void
  onImport?: (keypair: Keypair) => void
  navigate?: (to: string) => void
  error?: string | null
  sseConnected?: boolean
}

export function Layout({ children, identity, onLogout, onImport, navigate, error, sseConnected }: LayoutProps) {
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

  const handleCopy = () => {
    if (!identity) return
    navigator.clipboard.writeText(identity.address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    // Inset the whole shell rather than each bar: index.html opts into
    // viewport-fit=cover, so the notch and home indicator are ours to avoid.
    <div className="flex flex-col h-dvh max-w-[900px] mx-auto border-x border-neutral-800 safe-top safe-bottom safe-x">
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
            <button onClick={handleCopy} title="Copy Address" aria-label="Copy address" className="max-sm:border-0">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            <button onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/chat/${identity.address}`); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000) }} title="Copy conversation link" aria-label="Copy conversation link" className="max-sm:border-0">
              {linkCopied ? <Check size={14} /> : <Link size={14} />}
            </button>
            <button onClick={() => setShowQR(true)} title="Show QR code" aria-label="Show QR code" className="max-sm:border-0">
              <QrCode size={14} />
            </button>
            <button onClick={() => setShowSettings(!showSettings)} title="Settings" aria-label="Settings" aria-expanded={showSettings} className="max-sm:border-0">
              <Settings size={14} />
            </button>
            <button
              onClick={() => {
                if (logoutConfirm) { onLogout() } else {
                  setLogoutConfirm(true)
                  logoutTimeoutRef.current = setTimeout(() => setLogoutConfirm(false), 3000)
                }
              }}
              title={logoutConfirm ? 'Click again to confirm' : 'Logout'}
              aria-label="Logout"
              className={`max-sm:border-0 ${logoutConfirm ? 'text-red-400' : ''}`}
            >
              <LogOut size={14} />
            </button>
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
              onImport={(kp) => { onImport?.(kp); setShowSettings(false) }}
            />
          </section>
        )}
        {children}
      </main>
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
