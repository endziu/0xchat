import { useState, useRef, useEffect } from 'preact/hooks'
import { Keypair, saveKeypair, deriveKeypair } from '../lib/burner'
import { Download, Upload, Eye, EyeOff, X } from 'lucide-preact'
import { useToast } from './Toast'

interface KeyManagementProps {
  identity: Keypair
  onImport: (keypair: Keypair) => void
}

export function KeyManagement({ identity, onImport }: KeyManagementProps) {
  const { toast } = useToast()
  const [showKey, setShowKey] = useState(false)
  const [importHex, setImportHex] = useState('')
  const [previewKeypair, setPreviewKeypair] = useState<Keypair | null>(null)
  const [confirmTimeout, setConfirmTimeout] = useState(false)
  const confirmTimeoutRef = useRef<any>(null)

  useEffect(() => {
    return () => { if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current) }
  }, [])

  const handleImportPreview = () => {
    if (!importHex.trim()) return
    try {
      const hex = importHex.trim().startsWith('0x') ? importHex.trim() : `0x${importHex.trim()}`
      if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('Invalid private key format')
      setPreviewKeypair(deriveKeypair(hex))
    } catch (err: any) { toast(err.message, 'error') }
  }

  const handleImportConfirm = () => {
    if (!previewKeypair) return
    try {
      saveKeypair(previewKeypair)
      onImport(previewKeypair)
      setImportHex('')
      setPreviewKeypair(null)
      toast('Key imported', 'success')
    } catch (err: any) { toast(err.message, 'error') }
  }

  const handleCancelPreview = () => {
    setPreviewKeypair(null)
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current)
    setConfirmTimeout(false)
  }

  return (
    <div>
      <div className="mt-3">
        <h3>Export Private Key</h3>
        <p>Save this key to restore your account on another device.</p>
        <div className="flex items-center gap-1 mt-1.5">
          <input type={showKey ? 'text' : 'password'} readOnly value={identity.privateKey} className="flex-1" />
          <button onClick={() => setShowKey(!showKey)} title="Toggle visibility">
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button onClick={() => { navigator.clipboard.writeText(identity.privateKey); toast('Copied', 'success') }} title="Copy">
            <Download size={14} />
          </button>
        </div>
      </div>

      <div className="mt-4">
        <h3>Import Private Key</h3>
        <p>This will overwrite your current burner wallet.</p>
        {!previewKeypair ? (
          <div className="flex items-center gap-1 mt-1.5">
            <input type="password" placeholder="0x..." value={importHex} onInput={(e: any) => setImportHex(e.target.value)} className="flex-1" />
            <button onClick={handleImportPreview} disabled={!importHex.trim()} title="Preview"><Upload size={14} /></button>
          </div>
        ) : (
          <div className="mt-2">
            <div className="flex justify-between items-center">
              <span className="text-sm text-neutral-500">New Address</span>
              <button onClick={handleCancelPreview} title="Cancel" className="border-0 p-0.5"><X size={14} /></button>
            </div>
            <div className="text-sm text-neutral-400 mt-1">{previewKeypair.address}</div>
            <div className="flex gap-1 mt-2">
              <button onClick={() => {
                if (confirmTimeout) { handleImportConfirm() } else {
                  setConfirmTimeout(true)
                  confirmTimeoutRef.current = setTimeout(() => setConfirmTimeout(false), 3000)
                }
              }}>{confirmTimeout ? 'Confirm?' : 'Import'}</button>
              <button onClick={handleCancelPreview}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
