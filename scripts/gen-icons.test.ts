import { expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'

const readIdat = (png: Uint8Array) => {
  const chunks: Uint8Array[] = []
  let offset = 8
  while (offset < png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0)
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8))
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const idat = new Uint8Array(chunks.reduce((length, part) => length + part.length, 0))
  let writeOffset = 0
  for (const part of chunks) {
    idat.set(part, writeOffset)
    writeOffset += part.length
  }
  return idat
}

test('generated favicon is a decodable, visible PNG', async () => {
  const generated = Bun.spawnSync(['bun', 'run', 'scripts/gen-icons.ts'])
  expect(generated.exitCode).toBe(0)

  const png = new Uint8Array(await Bun.file('public/favicon-32.png').arrayBuffer())
  const raw = new Uint8Array(inflateSync(readIdat(png)))
  expect(raw).toHaveLength(32 * (1 + 32 * 4))

  let foregroundPixels = 0
  for (let y = 0; y < 32; y++) {
    expect(raw[y * 129]).toBe(0)
    for (let x = 0; x < 32; x++) {
      const offset = y * 129 + 1 + x * 4
      expect(raw[offset + 3]).toBe(255)
      if (raw[offset] !== 10 || raw[offset + 1] !== 10 || raw[offset + 2] !== 10) foregroundPixels++
    }
  }
  expect(foregroundPixels).toBeGreaterThan(0)
})
