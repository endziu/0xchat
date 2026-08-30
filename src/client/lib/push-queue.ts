// Serialize async operations so their side effects run strictly one at a time,
// in the order they were enqueued. This closes push races where a stale
// session-start POST could otherwise land after a newer unsubscribe DELETE:
// operations now execute sequentially, and a caller that is no longer the
// current generation (see isStale checks) skips its server write when its turn
// arrives.
interface SerialQueue {
  enqueue<T>(fn: () => Promise<T>): Promise<T>
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve()

  return {
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(() => fn())
      // Keep the chain going even if an op rejects.
      tail = result.catch(() => undefined)
      return result
    },
  }
}
