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
    return () => {
      if (logoutTimeoutRef.current) clearTimeout(logoutTimeoutRef.current)
    }
  }, [])

  const handleCopy = () => {
    if (!identity) return
    navigator.clipboard.writeText(identity.address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex flex-col h-screen max-w-5xl mx-auto border-x border-border bg-bg relative">
      {error && (
        <div className="bg-error/20 border-b border-error/50 px-4 py-3 text-sm text-error">
          {error}
        </div>
      )}
      <header className="flex items-center justify-between p-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <a
            href="/chat"
            onClick={(e) => { e.preventDefault(); navigate?.('/chat') }}
            className="font-serif text-2xl italic hover:text-accent transition-colors"
          >
            <span className="text-accent not-italic mr-1">⬡</span> 0xChat
          </a>
          {sseConnected !== undefined && (
            <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-mono tracking-widest uppercase font-bold ${
              sseConnected ? 'bg-green-500/20 text-green-400' : 'bg-amber-500/20 text-amber-400 animate-pulse'
            }`}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'currentColor' }}></span>
              {sseConnected ? 'Live' : 'Connecting'}
            </div>
          )}
        </div>

        {identity && (
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-2 text-dim font-mono">
              <span className="truncate max-w-[120px] sm:max-w-[150px] lg:max-w-none">{identity.address}</span>
              <button
                onClick={handleCopy}
                className="hover:text-accent transition-colors p-1 shrink-0"
                title="Copy Address"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-1 transition-colors ${showSettings ? 'text-accent' : 'text-dim hover:text-accent'}`}
              title="Identity / Settings"
            >
              <Settings size={16} />
            </button>
            <button
              onClick={() => {
                if (logoutConfirm) {
                  onLogout()
                } else {
                  setLogoutConfirm(true)
                  logoutTimeoutRef.current = setTimeout(() => {
                    setLogoutConfirm(false)
                  }, 3000)
                }
              }}
              className={`p-1 transition-colors cursor-pointer ${
                logoutConfirm ? 'text-error animate-pulse' : 'text-dim hover:text-error'
              }`}
              title="Logout / Delete Burner Key"
            >
              <LogOut size={16} />
            </button>
            {logoutConfirm && (
              <span className="text-[10px] text-error font-mono uppercase tracking-widest animate-pulse">
                Click again to confirm
              </span>
            )}
          </div>
        )}
      </header>
      
      <main className="flex-1 min-h-0 relative">
        {showSettings && identity && (
          <div className="absolute inset-0 z-50 bg-bg p-8 flex flex-col items-center justify-center">
            <div className="max-w-md w-full">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-serif italic text-accent">Identity Settings</h2>
                <button onClick={() => setShowSettings(false)} className="text-dim hover:text-text cursor-pointer">Close</button>
              </div>
              <KeyManagement
                identity={identity}
                onImport={(kp) => {
                  onImport?.(kp)
                  setShowSettings(false)
                }}
              />
            </div>
          </div>
        )}
        {children}
      </main>
    </div>
  )
}
