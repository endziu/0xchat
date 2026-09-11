import { useState, useRef, useEffect } from 'preact/hooks'
import { Keypair, deriveKeypair } from '../lib/burner'
import { Copy, Check, Upload, Eye, EyeOff, X } from 'lucide-preact'
import { useToast } from './Toast'

interface KeyManagementProps {
  identity: Keypair
  onImport: (keypair: Keypair) => Promise<void>
}

export function KeyManagement({ identity, onImport }: KeyManagementProps) {
  const { toast } = useToast()
  const [showKey, setShowKey] = useState(false)
  const [keyCopied, setKeyCopied] = useState(false)
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

  const handleImportConfirm = async () => {
    if (!previewKeypair) return
    try {
      await onImport(previewKeypair)
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
    <section className="p-3">
      <h3>Identity</h3>

      <div className="mt-3">
        <label htmlFor="export-private-key" className="text-sm text-neutral-400">Export private key</label>
        <div className="mt-1 flex items-center gap-1">
          <input id="export-private-key" type={showKey ? 'text' : 'password'} readOnly value={identity.privateKey} className="min-w-0 flex-1" />
          <button onClick={() => setShowKey(!showKey)} title={showKey ? 'Hide private key' : 'Show private key'} aria-label={showKey ? 'Hide private key' : 'Show private key'}>
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button onClick={() => { navigator.clipboard.writeText(identity.privateKey); toast('Copied', 'success'); setKeyCopied(true); setTimeout(() => setKeyCopied(false), 2000) }} title="Copy private key" aria-label="Copy private key">
            {keyCopied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>

      <div className="mt-3">
        <label htmlFor="import-private-key" className="text-sm text-neutral-400">Import private key</label>
        {!previewKeypair ? (
          <div className="mt-1 flex items-center gap-1">
            <input id="import-private-key" type="password" placeholder="0x..." value={importHex} onInput={(e: any) => setImportHex(e.target.value)} className="min-w-0 flex-1" />
            <button onClick={handleImportPreview} disabled={!importHex.trim()} title="Import private key" aria-label="Import private key"><Upload size={14} /></button>
          </div>
        ) : (
          <div className="mt-1 border border-neutral-800 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-neutral-500">New address</span>
              <button onClick={handleCancelPreview} title="Cancel import" aria-label="Cancel import" className="border-0 p-0.5"><X size={14} /></button>
            </div>
            <div className="mt-1 break-all text-sm text-neutral-400">{previewKeypair.address}</div>
            <button className="mt-2" onClick={() => {
              if (confirmTimeout) { handleImportConfirm() } else {
                setConfirmTimeout(true)
                confirmTimeoutRef.current = setTimeout(() => setConfirmTimeout(false), 3000)
              }
            }}>{confirmTimeout ? 'Confirm import' : 'Import'}</button>
          </div>
        )}
      </div>
    </section>
  )
}
