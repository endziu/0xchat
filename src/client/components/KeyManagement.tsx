import { useState } from 'preact/hooks'
import { Keypair, saveKeypair, deriveKeypair } from '../lib/burner'
import { Download, Upload, Eye, EyeOff } from 'lucide-preact'

interface KeyManagementProps {
  identity: Keypair
  onImport: (keypair: Keypair) => void
}

export function KeyManagement({ identity, onImport }: KeyManagementProps) {
  const [showKey, setShowKey] = useState(false)
  const [importHex, setImportHex] = useState('')
  const [status, setStatus] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const setStatusWithTimeout = (type: 'ok' | 'err', text: string) => {
    setStatus({ type, text })
    setTimeout(() => setStatus(null), 2000)
  }

  const handleImport = () => {
    if (!importHex.trim()) return
    try {
      const hex = importHex.trim().startsWith('0x') ? importHex.trim() : `0x${importHex.trim()}`
      if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('Invalid private key format')

      const newKeypair = deriveKeypair(hex)
      saveKeypair(newKeypair)
      onImport(newKeypair)
      setImportHex('')
      setStatusWithTimeout('ok', 'Key imported successfully!')
    } catch (err: any) {
      setStatusWithTimeout('err', err.message)
    }
  }

  return (
    <div className="p-4 border border-border bg-surface/20 rounded flex flex-col gap-6">
      <div className="space-y-2">
        <h3 className="text-[10px] uppercase tracking-widest text-accent font-bold">Export Private Key</h3>
        <p className="text-[10px] text-dim italic">Save this key in a safe place to restore your account on another device.</p>
        <div className="flex items-center gap-2 mt-2">
          <input
            type={showKey ? 'text' : 'password'}
            readOnly
            value={identity.privateKey}
            className="flex-1 bg-surface border border-border rounded px-3 py-1.5 text-xs font-mono"
          />
          <button 
            onClick={() => setShowKey(!showKey)}
            className="p-1.5 text-dim hover:text-accent transition-colors border border-border rounded"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button
            onClick={() => {
              navigator.clipboard.writeText(identity.privateKey)
              setStatusWithTimeout('ok', 'Copied to clipboard!')
            }}
            className="p-1.5 text-dim hover:text-accent transition-colors border border-border rounded cursor-pointer"
          >
            <Download size={14} />
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-[10px] uppercase tracking-widest text-accent font-bold">Import Private Key</h3>
        <p className="text-[10px] text-dim italic">Warning: This will overwrite your current burner wallet.</p>
        <div className="flex items-center gap-2 mt-2">
          <input
            type="password"
            placeholder="0x..."
            value={importHex}
            onInput={(e: any) => setImportHex(e.target.value)}
            className="flex-1 bg-surface border border-border rounded px-3 py-1.5 text-xs font-mono"
          />
          <button
            onClick={handleImport}
            className="p-1.5 text-accent hover:bg-accent hover:text-bg transition-colors border border-accent rounded cursor-pointer"
          >
            <Upload size={14} />
          </button>
        </div>
        {status && (
          <p className={`text-xs ${status.type === 'ok' ? 'text-accent' : 'text-error'}`}>
            {status.text}
          </p>
        )}
      </div>
    </div>
  )
}
