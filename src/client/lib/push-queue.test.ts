import { describe, expect, test } from 'bun:test'
import { createSerialQueue } from './push-queue'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('createSerialQueue', () => {
  test('runs enqueued ops sequentially in claim order, no overlap', async () => {
    const q = createSerialQueue()
    const seq: string[] = []
    const task = (name: string, ms: number) =>
      q.enqueue(async () => {
        seq.push(`${name}:start`)
        await delay(ms)
        seq.push(`${name}:end`)
      })

    await Promise.all([task('A', 20), task('B', 5), task('C', 1)])

    expect(seq).toEqual(['A:start', 'A:end', 'B:start', 'B:end', 'C:start', 'C:end'])
  })

  test('a superseded op skips its write; only the newest valid op writes last', async () => {
    const q = createSerialQueue()
    let claimed = 0
    const claim = () => ++claimed
    const isStale = (gen: number) => gen !== claimed
    const writes: string[] = []

    // Re-upload (A) claims, then unsubscribe (B) claims while A is in flight.
    const genA = claim()
    const genB = claim()

    const a = q.enqueue(async () => {
      await delay(20) // A's POST is in flight
      if (isStale(genA)) return // superseded before its write lands
      writes.push('A')
    })
    const b = q.enqueue(async () => {
      await delay(5) // B's DELETE
      if (isStale(genB)) return
      writes.push('B')
    })

    await Promise.all([a, b])

    // A never performed its write (it was superseded); B wrote last.
    expect(writes).toEqual(['B'])
  })

  test('keeps chaining after a rejected op', async () => {
    const q = createSerialQueue()
    const ran: string[] = []
    const first = q.enqueue(async () => { throw new Error('boom') })
    const second = q.enqueue(async () => { ran.push('second'); return 1 })
    await expect(first).rejects.toThrow('boom')
    expect(await second).toBe(1)
    expect(ran).toEqual(['second'])
  })
})
