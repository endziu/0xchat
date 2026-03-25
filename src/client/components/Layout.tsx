import { ComponentChildren } from 'preact'
import { useState, useRef, useEffect } from 'preact/hooks'
import { Keypair } from '../lib/burner'
import { LogOut, Settings, Copy, Check, Link } from 'lucide-preact'
import { KeyManagement } from './KeyManagement'

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
  const [showSettings, setShowSettings] = useState(false)
  const [copied, setCopied] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const [logoutConfirm, setLogoutConfirm] = useState(false)
  const logoutTimeoutRef = useRef<any>(null)

  useEffect(() => {
    return () => { if (logoutTimeoutRef.current) clearTimeout(logoutTimeoutRef.current) }
  }, [])

  const handleCopy = () => {
    if (!identity) return
    navigator.clipboard.writeText(identity.address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex flex-col h-dvh max-w-[900px] mx-auto border-x border-neutral-800">
      {error && <div className="p-2 text-center text-neutral-500 border-b border-neutral-800">{error}</div>}
      <header className="flex items-center justify-between p-2 border-b border-neutral-800 shrink-0 gap-2">
        <div className="flex items-center gap-2">
          <a href="/chat" onClick={(e) => { e.preventDefault(); navigate?.('/chat') }}>⬡ 0xChat</a>
          {sseConnected !== undefined && (
            <span className="flex items-center gap-1 text-neutral-600 text-sm">
              <span className={`w-1.5 h-1.5 rounded-full ${sseConnected ? 'bg-green-400' : 'bg-neutral-700'}`} />
              {sseConnected ? 'Live' : '...'}
            </span>
          )}
        </div>
        {identity && (
          <div className="flex items-center gap-2 text-sm text-neutral-500">
            <span className="max-sm:hidden">{identity.address.slice(0, 6)}...{identity.address.slice(-4)}</span>
            <button onClick={handleCopy} title="Copy Address">
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
            <button onClick={() => { navigator.clipboard.writeText(`https://chat.endziu.xyz/chat/${identity.address}`); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000) }} title="Copy conversation link">
              {linkCopied ? <Check size={12} /> : <Link size={14} />}
            </button>
            <button onClick={() => setShowSettings(!showSettings)} title="Settings">
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
              className={logoutConfirm ? 'text-red-400' : ''}
            >
              <LogOut size={14} />
            </button>
          </div>
        )}
      </header>
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
    </div>
  )
}
