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

// A clock the test moves by hand, so a 30-second deadline passes instantly.
export function createClock() {
  let now = 0
  let nextId = 0
  let timers: { id: number; at: number; callback: () => void }[] = []
  return {
    now: () => now,
    setTimeout: (callback: () => void, ms: number) => {
      timers.push({ id: ++nextId, at: now + ms, callback })
      return nextId
    },
    clearTimeout: (id: unknown) => { timers = timers.filter(timer => timer.id !== id) },
    advance(ms: number) {
      now += ms
      const due = timers.filter(timer => timer.at <= now)
      timers = timers.filter(timer => timer.at > now)
      for (const timer of due) timer.callback()
    },
  }
}

/** Whether a promise has settled after pending microtasks and I/O have run. */
export async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  await Bun.sleep(5)
  return settled
}

export interface PushWorkerEnv {
  pushManager: Pick<PushManager, 'subscribe' | 'getSubscription'>
  // The worker's own view of the origin's locks. A page reload does not drop
  // what the worker holds, so tests keep this apart from the pages' manager.
  locks?: PushLockManager | null
  now?: () => number
  channelName?: string
}

/** The production public/sw.js, as `registration.active` is to a page. */
export async function loadPushWorker(env: PushWorkerEnv) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>()
  const running: Promise<unknown>[] = []
  const worker = {
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => handlers.set(type, handler),
    location: { origin: 'http://localhost' },
    registration: { pushManager: env.pushManager },
    navigator: { locks: env.locks ?? undefined },
  }
  const channelName = env.channelName ?? `push-worker-${crypto.randomUUID()}`
  class Channel extends BroadcastChannel { constructor() { super(channelName) } }
  const source = await Bun.file(new URL('../../../public/sw.js', import.meta.url)).text()
  Function('self', 'BroadcastChannel', 'Date', source)(worker, Channel, { now: env.now ?? Date.now })
  const active = {
    postMessage(data: unknown, transfer: Transferable[] = []) {
      handlers.get('message')!({ data, ports: transfer, waitUntil: (work: Promise<unknown>) => { running.push(work) } })
    },
  } as unknown as ServiceWorker
  return { active, running }
}
