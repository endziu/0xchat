import { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import { Keypair } from '../lib/burner'
import { LogOut, Settings, Copy, Check } from 'lucide-preact'
import { KeyManagement } from './KeyManagement'

interface LayoutProps {
  children: ComponentChildren
  identity: Keypair | null
  onLogout: () => void
  onImport?: (keypair: Keypair) => void
  navigate?: (to: string) => void
}

export function Layout({ children, identity, onLogout, onImport, navigate }: LayoutProps) {
  const [showSettings, setShowSettings] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (!identity) return
    navigator.clipboard.writeText(identity.address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex flex-col h-screen max-w-5xl mx-auto border-x border-border bg-bg relative">
      <header className="flex items-center justify-between p-4 border-b border-border shrink-0">
        <a 
          href="/chat" 
          onClick={(e) => { e.preventDefault(); navigate?.('/chat') }}
          className="font-serif text-2xl italic hover:text-accent transition-colors"
        >
          <span className="text-accent not-italic mr-1">⬡</span> 0xChat
        </a>
        
        {identity && (
          <div className="flex items-center gap-4 text-xs">
            <div className="hidden lg:flex items-center gap-2 text-dim font-mono">
              <span className="truncate max-w-[150px] xl:max-w-none">{identity.address}</span>
              <button 
                onClick={handleCopy}
                className="hover:text-accent transition-colors p-1"
                title="Copy Address"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
            <div className="lg:hidden text-dim font-mono">
              {identity.address.slice(0, 6)}...{identity.address.slice(-4)}
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
                if (confirm('Delete your burner wallet? This cannot be undone.')) {
                  onLogout()
                }
              }}
              className="p-1 text-dim hover:text-error transition-colors cursor-pointer"
              title="Logout / Delete Burner Key"
            >
              <LogOut size={16} />
            </button>
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
