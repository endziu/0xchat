import { useEffect, useRef, useState } from 'preact/hooks'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { X, QrCode, Camera } from 'lucide-preact'
import { Modal } from './Modal'

interface QRModalProps {
  mode: 'show' | 'scan'
  address?: string
  onClose: () => void
  onScan: (address: string) => void
}

function parseScannedAddress(text: string): string | null {
  let candidate = text.trim()
  try {
    const url = new URL(text)
    const match = url.pathname.match(/\/chat\/([^/]+)/)
    if (match) candidate = match[1]
  } catch {
    // not a URL — treat the raw text as the address
  }
  return /^0x[0-9a-fA-F]{40}$/.test(candidate) ? candidate : null
}

// Your address as a scannable conversation link, with the address beneath it.
export function AddressQR({ address, size = 220 }: { address: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!canvasRef.current) return
    QRCode.toCanvas(canvasRef.current, `${window.location.origin}/chat/${address}`, { margin: 1, width: size }).catch(() => {})
  }, [address, size])
  return (
    <>
      <canvas ref={canvasRef} className="bg-white" />
      <p className="text-sm text-neutral-500 break-all text-center">{address}</p>
    </>
  )
}

export function QRModal({ mode: initialMode, address, onClose, onScan }: QRModalProps) {
  const [mode, setMode] = useState(initialMode)
  const [scanError, setScanError] = useState('')
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
    <Modal onClose={onClose} labelledBy="qr-title" className="max-w-xs">
      <div className="flex items-center justify-between p-2 border-b border-neutral-800">
        <h2 id="qr-title" className="sr-only">{mode === 'show' ? 'My QR code' : 'Scan a QR code'}</h2>
        <div className="flex gap-1">
          <button onClick={() => setMode('show')} aria-pressed={mode === 'show'} className={mode === 'show' ? 'text-neutral-200' : 'text-neutral-500'} title="My code" aria-label="My code">
            <QrCode size={16} />
          </button>
          <button onClick={() => setMode('scan')} aria-pressed={mode === 'scan'} className={mode === 'scan' ? 'text-neutral-200' : 'text-neutral-500'} title="Scan code" aria-label="Scan code">
            <Camera size={16} />
          </button>
        </div>
        <button onClick={onClose} aria-label="Close" title="Close"><X size={16} /></button>
      </div>

      <div className="p-3 flex flex-col items-center gap-2">
        {mode === 'show' ? (
          address && <AddressQR address={address} />
        ) : (
          <>
            <video ref={videoRef} className="w-full aspect-square object-cover bg-neutral-950" muted playsInline />
            {scanError && <p className="text-red-400">{scanError}</p>}
          </>
        )}
      </div>
    </Modal>
  )
}
