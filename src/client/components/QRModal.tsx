import { useEffect, useRef, useState } from 'preact/hooks'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { X, QrCode, Camera } from 'lucide-preact'

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

export function QRModal({ mode: initialMode, address, onClose, onScan }: QRModalProps) {
  const [mode, setMode] = useState(initialMode)
  const [scanError, setScanError] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    if (mode !== 'show' || !address || !canvasRef.current) return
    const url = `${window.location.origin}/chat/${address}`
    QRCode.toCanvas(canvasRef.current, url, { margin: 1, width: 220 }).catch(() => {})
  }, [mode, address])

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3" onClick={onClose}>
      <div className="w-full max-w-xs bg-black border border-neutral-800 flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-2 border-b border-neutral-800">
          <div className="flex gap-1">
            <button onClick={() => setMode('show')} aria-pressed={mode === 'show'} className={mode === 'show' ? 'text-neutral-200' : 'text-neutral-600'} title="My code">
              <QrCode size={16} />
            </button>
            <button onClick={() => setMode('scan')} aria-pressed={mode === 'scan'} className={mode === 'scan' ? 'text-neutral-200' : 'text-neutral-600'} title="Scan code">
              <Camera size={16} />
            </button>
          </div>
          <button onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="p-3 flex flex-col items-center gap-2">
          {mode === 'show' ? (
            <>
              <canvas ref={canvasRef} className="bg-white" />
              <p className="text-sm text-neutral-500 break-all text-center">{address}</p>
            </>
          ) : (
            <>
              <video ref={videoRef} className="w-full aspect-square object-cover bg-neutral-950" muted playsInline />
              {scanError && <p className="text-red-400">{scanError}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
