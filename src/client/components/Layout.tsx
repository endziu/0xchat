import { ComponentChildren } from 'preact'
import { useState, useRef, useEffect } from 'preact/hooks'
import { Keypair } from '../lib/burner'
import { LogOut, Settings, Copy, Check } from 'lucide-preact'
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
            <span className="flex items-center gap-1 text-neutral-600 text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full ${sseConnected ? 'bg-green-400' : 'bg-neutral-700'}`} />
              {sseConnected ? 'Live' : '...'}
            </span>
          )}
        </div>
        {identity && (
          <div className="flex items-center gap-2 text-[11px] text-neutral-500">
            <span>{identity.address.slice(0, 6)}...{identity.address.slice(-4)}</span>
            <button onClick={handleCopy} title="Copy Address">
              {copied ? <Check size={12} /> : <Copy size={12} />}
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
              title="Logout"
            >
              <LogOut size={14} />
            </button>
            {logoutConfirm && <span className="text-[11px] text-red-400">confirm?</span>}
          </div>
        )}
      </header>
      <main className="flex-1 overflow-hidden flex flex-col">
        {showSettings && identity && (
          <div className="p-3 border-b border-neutral-800">
            <div className="flex justify-between items-center">
              <h2>Identity</h2>
              <button onClick={() => setShowSettings(false)}>Close</button>
            </div>
            <KeyManagement
              identity={identity}
              onImport={(kp) => { onImport?.(kp); setShowSettings(false) }}
            />
          </div>
        )}
        {children}
      </main>
    </div>
  )
}
