import type { PushLockManager } from './push-coordinator'

// Web Locks semantics for tests: one holder per name across the origin, with
// every other caller queued behind it. happy-dom has no `navigator.locks`, so
// the coordinator's primary path needs this to be exercised at all.
export function createLockManager(): PushLockManager {
  const held = new Map<string, Promise<unknown>>()
  return {
    request: (name, _options, callback) => {
      const result = (held.get(name) ?? Promise.resolve()).then(() => callback())
      held.set(name, result.catch(() => undefined))
      return result
    },
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
