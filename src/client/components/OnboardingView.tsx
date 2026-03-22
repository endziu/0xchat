import { useState } from 'preact/hooks'
import { deriveKeypair } from '../lib/burner'
import { ChevronDown, ChevronUp } from 'lucide-preact'

interface OnboardingViewProps {
  onRegister: () => Promise<void>
  onImport?: (privateKey: string) => Promise<void>
}

export function OnboardingView({ onRegister, onImport }: OnboardingViewProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [importKey, setImportKey] = useState('')

  const handleRegister = async () => {
    setLoading(true)
    setError(null)
    try {
      await onRegister()
    } catch (err: any) {
      setError(err.message || 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  const handleImportSubmit = async () => {
    if (!importKey.trim()) return
    setLoading(true)
    setError(null)
    try {
      const hex = importKey.trim().startsWith('0x') ? importKey.trim() : `0x${importKey.trim()}`
      if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('Invalid private key format')

      deriveKeypair(hex) // Validate key
      if (onImport) {
        await onImport(hex)
      }
    } catch (err: any) {
      setError(err.message || 'Import failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-full p-8 max-w-md mx-auto text-center gap-6">
      <div className="text-accent text-5xl mb-2 italic font-serif leading-tight">Welcome to 0xChat</div>
      <p className="text-dim leading-relaxed">
        An end-to-end encrypted, ephemeral chat.
        A burner keypair has been generated locally in your browser.
      </p>

      <div className="p-4 bg-surface border border-border rounded w-full flex flex-col gap-2">
        <div className="text-[10px] uppercase tracking-widest text-dim text-left">Security Note</div>
        <p className="text-[10px] text-dim text-left italic">
          Your identity is stored in localStorage. Clearing site data will delete your account and all history.
          Encryption keys never leave your device.
        </p>
      </div>

      <button
        onClick={handleRegister}
        disabled={loading}
        className="w-full py-3 bg-accent text-bg font-bold uppercase tracking-wider hover:brightness-110 transition-all disabled:opacity-50 cursor-pointer"
      >
        {loading ? 'Processing...' : 'Get Started'}
      </button>

      {onImport && (
        <button
          onClick={() => setShowImport(!showImport)}
          className="flex items-center gap-2 text-dim hover:text-accent transition-colors text-sm"
        >
          Import existing key
          {showImport ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      )}

      {showImport && onImport && (
        <div className="w-full p-4 bg-surface border border-border rounded flex flex-col gap-2">
          <input
            type="password"
            placeholder="0x..."
            value={importKey}
            onInput={(e: any) => setImportKey(e.target.value)}
            className="bg-bg border border-border rounded px-3 py-2 text-xs font-mono focus:outline-none focus:border-accent"
          />
          <button
            onClick={handleImportSubmit}
            disabled={loading || !importKey.trim()}
            className="py-2 bg-accent text-bg font-bold uppercase tracking-wider hover:brightness-110 transition-all disabled:opacity-50 cursor-pointer text-xs"
          >
            {loading ? 'Importing...' : 'Import'}
          </button>
        </div>
      )}

      <div className="min-h-[1.5rem] w-full">
        {error && <p className="text-error text-sm font-mono">{error}</p>}
      </div>
    </div>
  )
}
