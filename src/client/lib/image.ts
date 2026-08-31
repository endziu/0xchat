import { MAX_PLAINTEXT_BYTES } from '../../shared/message-envelope'

// A data URL is plain ASCII, so its string length equals the UTF-8 byte
// length the envelope will encrypt. Leave a small margin below the hard cap
// for the "data:image/jpeg;base64," prefix and JPEG encoding variance.
const SAFETY_MARGIN = 0.98
const MAX_DATA_URL_LENGTH = Math.floor(MAX_PLAINTEXT_BYTES * SAFETY_MARGIN)

const MAX_DIMENSION = 1600
const MIN_DIMENSION = 320
const QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4, 0.25]

export class ImageTooLargeError extends Error {}

/** Downscales/recompresses an image file to a data URL that fits the envelope's ciphertext cap. */
export async function compressImageFile(file: File): Promise<string> {
  // Already small enough: send as-is so format and transparency survive untouched.
  const original = await readAsDataUrl(file)
  if (original.length <= MAX_DATA_URL_LENGTH) return original

  const bitmap = await loadBitmap(file)
  try {
    let width = bitmap.width
    let height = bitmap.height
    const initialScale = Math.min(1, MAX_DIMENSION / Math.max(width, height))
    width = Math.round(width * initialScale)
    height = Math.round(height * initialScale)

    while (true) {
      for (const quality of QUALITY_STEPS) {
        const dataUrl = await drawAndEncode(bitmap, width, height, quality)
        if (dataUrl.length <= MAX_DATA_URL_LENGTH) return dataUrl
      }
      if (width <= MIN_DIMENSION || height <= MIN_DIMENSION) break
      width = Math.round(width * 0.75)
      height = Math.round(height * 0.75)
    }
    throw new ImageTooLargeError('Image is too large to send, even after compression. Try a smaller photo.')
  } finally {
    bitmap.close()
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read image'))
    reader.readAsDataURL(file)
  })
}

async function loadBitmap(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file)
  } catch {
    throw new Error('Failed to read image')
  }
}

function drawAndEncode(bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')
  // JPEG has no alpha channel; flatten onto white so transparent PNGs don't turn black.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('Failed to encode image')); return }
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('Failed to encode image'))
      reader.readAsDataURL(blob)
    }, 'image/jpeg', quality)
  })
}
