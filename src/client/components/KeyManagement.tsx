import { useState, useRef, useEffect } from 'preact/hooks'
import { Keypair, deriveKeypair } from '../../shared/keypair'
import { Copy, Check, ChevronRight, Upload, Eye, EyeOff } from 'lucide-preact'
import { AddressAvatar } from './AddressAvatar'
import { AddressHex } from './AddressHex'
import { ROW, SettingsGroup } from './SettingsGroup'
import { useToast } from './Toast'
import { useCopied } from '../hooks/useCopied'
import { errorMessage } from '../lib/errors'

interface KeyManagementProps {
  identity: Keypair
  onImport: (keypair: Keypair) => Promise<void>
}

export function KeyManagement({ identity, onImport }: KeyManagementProps) {
  const { toast } = useToast()
  const [showKey, setShowKey] = useState(false)
  const [keyCopied, copyKey] = useCopied()
  const [importing, setImporting] = useState(false)
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
    } catch (err) { toast(errorMessage(err, 'Failed to preview private key'), 'error') }
  }

  const handleImportConfirm = async () => {
    if (!previewKeypair) return
    try {
      await onImport(previewKeypair)
      setImportHex('')
      setPreviewKeypair(null)
      toast('Key imported', 'success')
    } catch (err) { toast(errorMessage(err, 'Failed to import private key'), 'error') }
  }

  const handleCancelPreview = () => {
    setPreviewKeypair(null)
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current)
    setConfirmTimeout(false)
  }

  return (
    <SettingsGroup title="Your key" foot="Your key is your account. Export it and keep it somewhere safe, or you lose this identity if this browser's storage is cleared.">
      <div className={`${ROW} pr-1`}>
        <span className="flex-1 font-mono [overflow-wrap:anywhere] text-text-2">
          {showKey ? identity.privateKey : '•••• •••• •••• •••• ••••'}
        </span>
        <button onClick={() => setShowKey(!showKey)} title={showKey ? 'Hide private key' : 'Show private key'} aria-label={showKey ? 'Hide private key' : 'Show private key'} className="icon-btn">
          {showKey ? <EyeOff size={20} /> : <Eye size={20} />}
        </button>
      </div>
      <button onClick={() => { copyKey(identity.privateKey); toast('Copied', 'success') }} className={`${ROW} hover:bg-raised/50`}>
        <span className="flex-1">Copy private key</span>
        <span className="mr-2.5 text-text-3">{keyCopied ? <Check size={18} /> : <Copy size={18} />}</span>
      </button>
      <button onClick={() => setImporting(!importing)} aria-expanded={importing} className={`${ROW} hover:bg-raised/50`}>
        <span className="flex-1">Import private key</span>
        <ChevronRight size={18} className={`mr-2.5 text-text-3 transition-transform motion-reduce:transition-none ${importing ? 'rotate-90' : ''}`} />
      </button>
      {importing && (
        <div className="grid justify-items-start gap-2.5 px-4 pt-3.5 pb-4">
          {!previewKeypair ? (
            <form className="flex w-full gap-2" onSubmit={(e) => { e.preventDefault(); handleImportPreview() }}>
              <input type="password" aria-label="Private key to import" placeholder="0x..." value={importHex} onInput={(e: any) => setImportHex(e.target.value)} className="min-w-0 flex-1 font-mono" />
              <button type="submit" disabled={!importHex.trim()} title="Import private key" aria-label="Import private key" className="btn min-h-12"><Upload size={18} /></button>
            </form>
          ) : (
            <>
              <span className="text-sm text-text-2">New address</span>
              <div className="flex items-center gap-3">
                <AddressAvatar address={previewKeypair.address} size={32} />
                <AddressHex address={previewKeypair.address} className="justify-start text-sm" />
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-accent" onClick={() => {
                  if (confirmTimeout) { handleImportConfirm() } else {
                    setConfirmTimeout(true)
                    confirmTimeoutRef.current = setTimeout(() => setConfirmTimeout(false), 3000)
                  }
                }}>{confirmTimeout ? 'Confirm import' : 'Import'}</button>
                <button onClick={handleCancelPreview} className="btn">Cancel</button>
              </div>
            </>
          )}
        </div>
      )}
    </SettingsGroup>
  )
}
