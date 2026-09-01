import { MAX_PLAINTEXT_BYTES } from '../../shared/message-envelope'

// A data URL is plain ASCII, so its string length equals the UTF-8 byte
// length the envelope will encrypt — prefix included. Leave a small margin
// below the hard cap for JPEG encoding variance.
const SAFETY_MARGIN = 0.98
export const MAX_DATA_URL_LENGTH = Math.floor(MAX_PLAINTEXT_BYTES * SAFETY_MARGIN)

const MAX_DIMENSION = 1600
const MIN_DIMENSION = 320
const SHRINK_FACTOR = 0.75
const QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4, 0.25]

export class ImageTooLargeError extends Error {}

export interface CompressionAttempt {
  width: number
  height: number
  quality: number
}

/**
 * The ordered attempts to fit an image under the budget: drop quality first at
 * a given size, since that costs less visible detail than shrinking, then
 * shrink and start the quality ladder again. Yielding the plan rather than
 * encoding inside the loop keeps the policy pure and testable — the encoder
 * needs a DOM, this does not.
 */
export function* compressionAttempts(srcWidth: number, srcHeight: number): Generator<CompressionAttempt> {
  const initialScale = Math.min(1, MAX_DIMENSION / Math.max(srcWidth, srcHeight))
  let width = Math.round(srcWidth * initialScale)
  let height = Math.round(srcHeight * initialScale)

  while (true) {
    for (const quality of QUALITY_STEPS) yield { width, height, quality }
    // Shrinking has nothing left to give only once the *longest* side is at
    // the floor. Testing either side would strand wide panoramas, whose short
    // side starts below the floor while the long side is still huge.
    if (Math.max(width, height) <= MIN_DIMENSION) return
    width = Math.round(width * SHRINK_FACTOR)
    height = Math.round(height * SHRINK_FACTOR)
  }
}

/**
 * Whether a file could still fit unmodified, from its byte size alone. base64
 * inflates by 4/3, so anything above that ratio is hopeless — and this spares
 * us decoding a multi-MB photo into a data URL just to measure it, which on a
 * phone is the expensive part.
 */
export function couldFitUnmodified(byteLength: number): boolean {
  return Math.ceil(byteLength / 3) * 4 <= MAX_DATA_URL_LENGTH
}

/** Downscales/recompresses an image file to a data URL that fits the envelope's ciphertext cap. */
export async function compressImageFile(file: File): Promise<string> {
  // Already small enough: send as-is so format and transparency survive untouched.
  if (couldFitUnmodified(file.size)) {
    const original = await readAsDataUrl(file)
    if (original.length <= MAX_DATA_URL_LENGTH) return original
  }

  const bitmap = await loadBitmap(file)
  try {
    for (const { width, height, quality } of compressionAttempts(bitmap.width, bitmap.height)) {
      const dataUrl = await drawAndEncode(bitmap, width, height, quality)
      if (dataUrl.length <= MAX_DATA_URL_LENGTH) return dataUrl
    }
    throw new ImageTooLargeError('Image is too large to send, even after compression. Try a smaller photo.')
  } finally {
    bitmap.close()
  }
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read image'))
    reader.readAsDataURL(blob)
  })
}

async function loadBitmap(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file)
  } catch {
    // The common cause is a format the browser cannot decode — notably HEIC
    // from an iPhone, which Chrome refuses — so name that rather than leaving
    // the user to guess at a generic read failure.
    throw new Error("Couldn't read this image. The format may not be supported — try JPEG or PNG.")
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

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Failed to encode image'))
    }, 'image/jpeg', quality)
  }).then(readAsDataUrl)
}
