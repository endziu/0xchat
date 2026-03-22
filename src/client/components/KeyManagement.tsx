import { useState, useRef, useEffect } from 'preact/hooks'
import { Keypair, saveKeypair, deriveKeypair } from '../lib/burner'
import { Download, Upload, Eye, EyeOff, X } from 'lucide-preact'
import { useToast } from './Toast'

interface KeyManagementProps {
  identity: Keypair
  onImport: (keypair: Keypair) => void
}

export function KeyManagement({ identity, onImport }: KeyManagementProps) {
  const toast = useToast()
  const [showKey, setShowKey] = useState(false)
  const [importHex, setImportHex] = useState('')
  const [previewKeypair, setPreviewKeypair] = useState<Keypair | null>(null)
  const [confirmTimeout, setConfirmTimeout] = useState(false)
  const confirmTimeoutRef = useRef<any>(null)

  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current)
    }
  }, [])

  const handleImportPreview = () => {
    if (!importHex.trim()) return
    try {
      const hex = importHex.trim().startsWith('0x') ? importHex.trim() : `0x${importHex.trim()}`
      if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('Invalid private key format')

      const newKeypair = deriveKeypair(hex)
      setPreviewKeypair(newKeypair)
    } catch (err: any) {
      toast(err.message, 'error')
    }
  }

  const handleImportConfirm = () => {
    if (!previewKeypair) return
    try {
      saveKeypair(previewKeypair)
      onImport(previewKeypair)
      setImportHex('')
      setPreviewKeypair(null)
      toast('Key imported successfully!', 'success')
    } catch (err: any) {
      toast(err.message, 'error')
    }
  }

  const handleCancelPreview = () => {
    setPreviewKeypair(null)
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current)
    setConfirmTimeout(false)
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
            title="Toggle visibility"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button
            onClick={() => {
              navigator.clipboard.writeText(identity.privateKey)
              toast('Copied to clipboard!', 'success')
            }}
            className="p-1.5 text-dim hover:text-accent transition-colors border border-border rounded cursor-pointer"
            title="Copy to clipboard"
          >
            <Download size={14} />
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-[10px] uppercase tracking-widest text-accent font-bold">Import Private Key</h3>
        <p className="text-[10px] text-dim italic">Warning: This will overwrite your current burner wallet.</p>

        {!previewKeypair ? (
          <div className="flex items-center gap-2 mt-2">
            <input
              type="password"
              placeholder="0x..."
              value={importHex}
              onInput={(e: any) => setImportHex(e.target.value)}
              className="flex-1 bg-surface border border-border rounded px-3 py-1.5 text-xs font-mono"
            />
            <button
              onClick={handleImportPreview}
              disabled={!importHex.trim()}
              className="p-1.5 text-accent hover:bg-accent hover:text-bg transition-colors border border-accent rounded cursor-pointer disabled:opacity-50"
              title="Preview imported address"
            >
              <Upload size={14} />
            </button>
          </div>
        ) : (
          <div className="p-3 bg-surface border border-border rounded space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-widest font-bold text-dim">New Address</span>
              <button
                onClick={handleCancelPreview}
                className="text-dim hover:text-error transition-colors p-1"
                title="Cancel"
              >
                <X size={14} />
              </button>
            </div>
            <div className="font-mono text-xs text-accent break-all">{previewKeypair.address}</div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => {
                  if (confirmTimeout) {
                    handleImportConfirm()
                  } else {
                    setConfirmTimeout(true)
                    confirmTimeoutRef.current = setTimeout(() => {
                      setConfirmTimeout(false)
                    }, 3000)
                  }
                }}
                className={`flex-1 px-3 py-1.5 rounded text-xs font-bold uppercase transition-colors ${
                  confirmTimeout
                    ? 'bg-error text-white animate-pulse'
                    : 'bg-accent text-bg hover:brightness-110'
                }`}
              >
                {confirmTimeout ? 'Confirm?' : 'Import'}
              </button>
              <button
                onClick={handleCancelPreview}
                className="px-3 py-1.5 border border-border rounded text-xs font-bold uppercase hover:border-error hover:text-error transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
