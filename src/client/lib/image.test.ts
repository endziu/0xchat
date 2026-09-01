import { describe, expect, test } from 'bun:test'
import { compressionAttempts, couldFitUnmodified, MAX_DATA_URL_LENGTH } from './image'

const sizes = (attempts: { width: number; height: number }[]) => {
  const seen: string[] = []
  for (const { width, height } of attempts) {
    const key = `${width}x${height}`
    if (seen[seen.length - 1] !== key) seen.push(key)
  }
  return seen
}

describe('compressionAttempts', () => {
  test('scales the longest side down to the 1600px ceiling, preserving aspect ratio', () => {
    const [first] = [...compressionAttempts(4000, 3000)]
    expect(first.width).toBe(1600)
    expect(first.height).toBe(1200)
  })

  test('never upscales an image that is already under the ceiling', () => {
    const [first] = [...compressionAttempts(800, 600)]
    expect(first.width).toBe(800)
    expect(first.height).toBe(600)
  })

  test('exhausts the quality ladder at a size before shrinking', () => {
    const attempts = [...compressionAttempts(4000, 3000)]
    const firstSize = attempts.filter((a) => a.width === 1600)
    expect(firstSize.map((a) => a.quality)).toEqual([0.85, 0.7, 0.55, 0.4, 0.25])
    // The size only changes once that ladder is spent.
    expect(attempts[5].width).toBeLessThan(1600)
  })

  test('keeps shrinking a wide panorama whose short side starts below the floor', () => {
    // 12000x400 scales to 1600x53: the height is under MIN_DIMENSION from the
    // very first attempt, but the width has plenty of room left to give.
    const attempts = [...compressionAttempts(12000, 400)]
    expect(attempts[0]).toEqual({ width: 1600, height: 53, quality: 0.85 })
    expect(sizes(attempts).length).toBeGreaterThan(1)
    expect(attempts[attempts.length - 1].width).toBeLessThanOrEqual(320)
  })

  test('stops once the longest side reaches the floor', () => {
    const attempts = [...compressionAttempts(4000, 3000)]
    const last = attempts[attempts.length - 1]
    expect(Math.max(last.width, last.height)).toBeLessThanOrEqual(320)
  })

  test('terminates for every aspect ratio, including degenerate ones', () => {
    for (const [w, h] of [[4000, 3000], [12000, 400], [400, 12000], [1, 9000], [9000, 1], [10, 10]]) {
      const attempts = [...compressionAttempts(w, h)]
      expect(attempts.length).toBeGreaterThan(0)
      // Bounded: the long side starts at <=1600 and shrinks by 0.75 to 320,
      // so at most 7 sizes x 5 quality steps.
      expect(attempts.length).toBeLessThanOrEqual(35)
    }
  })
})

describe('couldFitUnmodified', () => {
  test('accepts a file whose base64 expansion lands inside the budget', () => {
    const bytes = Math.floor((MAX_DATA_URL_LENGTH / 4) * 3) - 3
    expect(couldFitUnmodified(bytes)).toBe(true)
  })

  test('rejects a file that base64 expansion pushes over the budget', () => {
    const bytes = Math.floor((MAX_DATA_URL_LENGTH / 4) * 3) + 3
    expect(couldFitUnmodified(bytes)).toBe(false)
  })

  test('rejects a typical multi-megabyte phone photo outright, without reading it', () => {
    expect(couldFitUnmodified(3_700_000)).toBe(false)
  })

  test('accepts a small image', () => {
    expect(couldFitUnmodified(40_000)).toBe(true)
  })
})
