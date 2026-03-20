import { useState } from 'preact/hooks'

interface OnboardingViewProps {
  onRegister: () => Promise<void>
}

export function OnboardingView({ onRegister }: OnboardingViewProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className="flex flex-col items-center justify-center h-full p-8 max-w-md mx-auto text-center gap-6">
      <div className="text-accent text-5xl mb-2 italic font-serif leading-tight">Welcome to eth-chat</div>
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
        {loading ? 'Registering...' : 'Get Started'}
      </button>
      
      <div className="min-h-[1.5rem] w-full">
        {error && <p className="text-error text-sm font-mono">{error}</p>}
      </div>
    </div>
  )
}
