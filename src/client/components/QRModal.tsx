import { conversationUrl, parseScannedAddress } from '../lib/address-links'
import { checksumAddress, type Address } from '../../shared/address'
import { useEffect, useRef, useState } from 'preact/hooks'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { Camera, Check, Copy, Link } from 'lucide-preact'
import { AddressHex } from './AddressHex'
import { Modal } from './Modal'
import { Segmented } from './Segmented'
import { useCopied } from '../hooks/useCopied'

interface QRModalProps {
  mode: 'show' | 'scan'
  address?: Address
  onClose: () => void
  onScan: (address: Address) => void
}

// Your address as a scannable conversation link, dark on white whatever the theme.
function AddressQR({ address, size = 208 }: { address: Address; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!canvasRef.current) return
    QRCode.toCanvas(canvasRef.current, conversationUrl(address), { margin: 1, width: size }).catch(() => {})
  }, [address, size])
  return (
    <div className="rounded-md bg-white p-4 leading-[0] shadow-[0_0_0_1px_var(--color-line)]">
      <canvas ref={canvasRef} />
    </div>
  )
}

export function QRModal({ mode: initialMode, address, onClose, onScan }: QRModalProps) {
  const [mode, setMode] = useState(initialMode)
  const [scanError, setScanError] = useState('')
  const [copied, copy] = useCopied()
  const [linkCopied, copyLink] = useCopied()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    if (mode !== 'scan') return
    setScanError('')
    let cancelled = false

    const scanCanvas = document.createElement('canvas')
    const scanCtx = scanCanvas.getContext('2d')

    const tick = () => {
      const video = videoRef.current
      if (!video || !scanCtx) return
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        scanCanvas.width = video.videoWidth
        scanCanvas.height = video.videoHeight
        scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height)
        const imageData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height)
        const result = jsQR(imageData.data, imageData.width, imageData.height)
        if (result) {
          const parsed = parseScannedAddress(result.data)
          if (parsed) {
            onScan(parsed)
            return
          }
          setScanError('QR code did not contain a valid address.')
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().catch(() => {})
        }
        rafRef.current = requestAnimationFrame(tick)
      })
      .catch(() => setScanError('Camera access denied or unavailable.'))

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [mode, onScan])

  return (
    <Modal onClose={onClose} title={address ? 'Share' : 'Scan a QR code'} kind="sheet">
      <div className="grid justify-items-center gap-4.5 px-5 pt-2 pb-6">
        {address && (
          <Segmented
            label="Share or scan"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'show', label: 'My code' },
              { value: 'scan', label: <><Camera size={16} />Scan</> },
            ]}
          />
        )}
        {mode === 'show' ? (
          address && (
            <>
              <AddressQR address={address} />
              <AddressHex address={address} className="max-w-[22ch]" />
              <div className="flex w-full gap-2">
                <button onClick={() => copy(checksumAddress(address))} className="btn btn-accent btn-lg flex-1">
                  {copied ? <Check size={18} /> : <Copy size={18} />}Copy address
                </button>
                <button onClick={() => copyLink(conversationUrl(address))} className="btn btn-lg flex-1">
                  {linkCopied ? <Check size={18} /> : <Link size={18} />}Copy link
                </button>
              </div>
            </>
          )
        ) : (
          <>
            <video ref={videoRef} className="aspect-square w-full rounded-md bg-raised object-cover" muted playsInline />
            {scanError ? <p className="text-danger">{scanError}</p> : <p className="text-sm text-text-2">Point your camera at a 0xChat code</p>}
          </>
        )}
      </div>
    </Modal>
  )
}
