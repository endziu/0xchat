// Generates the PWA icon set into public/. No image deps — raw PNG encoding.
// Run: bun run icons
import { mkdirSync } from 'node:fs'

const CRC = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC[n] = c >>> 0
}
const crc32 = (buf: Uint8Array) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** RGBA pixel buffer → PNG bytes (8-bit truecolour+alpha, filter 0). */
function encodePng(rgba: Uint8Array, size: number): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, size)
  v.setUint32(4, size)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(Bun.deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

type RGB = [number, number, number]
const BG: RGB = [10, 10, 10]      // neutral-950, matches the app shell
const FG: RGB = [229, 229, 229]   // neutral-200, matches body text

/** Signed distance from p to the segment ab. */
const distToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * Draws the ⬡ mark: a flat-top hexagon outline, antialiased by sampling the
 * distance field of its six edges. `inset` is the fraction of the canvas kept
 * clear around the glyph — maskable icons need ~20% so the safe zone survives
 * whatever shape the launcher crops to.
 */
function renderIcon(size: number, inset: number, transparent: boolean): Uint8Array {
  const rgba = new Uint8Array(size * size * 4)
  const cx = size / 2, cy = size / 2
  const r = (size / 2) * (1 - inset)
  const stroke = Math.max(1.5, size * 0.075)

  const pts: [number, number][] = []
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2 // vertex at top → vertical left/right sides
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5
      let d = Infinity
      for (let i = 0; i < 6; i++) {
        const [ax, ay] = pts[i]!
        const [bx, by] = pts[(i + 1) % 6]!
        d = Math.min(d, distToSegment(px, py, ax, ay, bx, by))
      }
      // 1px feather on each side of the stroke
      const cov = Math.max(0, Math.min(1, (stroke / 2 - d) + 0.5))
      const i = (y * size + x) * 4
      const bgA = transparent ? 0 : 255
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(BG[c]! * (1 - cov) + FG[c]! * cov)
      rgba[i + 3] = Math.round(bgA * (1 - cov) + 255 * cov)
    }
  }
  return rgba
}

const write = (name: string, size: number, inset: number, transparent = false) => {
  const png = encodePng(renderIcon(size, inset, transparent), size)
  Bun.write(`public/${name}`, png)
  console.log(`public/${name}  ${size}x${size}  ${(png.length / 1024).toFixed(1)}kB`)
}

mkdirSync('public', { recursive: true })
write('icon-192.png', 192, 0.14)
write('icon-512.png', 512, 0.14)
write('icon-maskable-512.png', 512, 0.28) // extra padding for launcher cropping
write('apple-touch-icon.png', 180, 0.16)  // iOS crops to a rounded square, opaque bg required
write('favicon-32.png', 32, 0.1)

await Bun.write(
  'public/favicon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#0a0a0a"/><path d="M16 4.5 26 10.25v11.5L16 27.5 6 21.75v-11.5Z" fill="none" stroke="#e5e5e5" stroke-width="2.4" stroke-linejoin="round"/></svg>\n`,
)
console.log('public/favicon.svg')
