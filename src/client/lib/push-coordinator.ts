// Origin-wide serialization for notification mutations (#84).
//
// Every tab of the origin shares one browser push subscription and one
// installation ID, so a per-hook queue only orders that tab's own operations.
// This coordinator adds the two missing pieces: an exclusive browser lock, so
// the side effects of concurrent tabs take turns rather than racing, and a
// shared generation in storage, so the newest intent supersedes older ones
// wherever they are running.
//
// Claims are taken when a mutation is requested, before the lock is awaited —
// a later click anywhere on the origin therefore invalidates an earlier one
// that is still queued or still in flight. A superseded operation must not
// upload, mark enabled, or delete anything it no longer owns; it re-reads
// authoritative state and uses server revisions to decide, because a local
// generation alone cannot recall a server request already sent.
//
// Every mutation is bounded (#85): a deadline started when the action is
// requested releases the caller after 30 seconds, not counting time spent in
// the permission prompt. Expiry invalidates the operation but cannot cancel a
// browser promise, so the lock stays held until the work actually settles and
// a persisted pending record keeps a reloaded tab from starting a conflicting
// mutation while its predecessor's native call may still land.

const GENERATION_KEY = '0xchat.push.generation'
const LOCK_NAME = '0xchat.push.subscription'
const CHANNEL_NAME = '0xchat.push'
const PENDING_KEY = '0xchat.push.pending'

export const PUSH_TIMEOUT_MS = 30_000
// How long a pending record from a tab that no longer holds the lock keeps
// conflicting work deferred. The owner cannot report settlement once it is gone.
export const PENDING_TTL_MS = 60_000

export const COORDINATION_UNAVAILABLE =
  'Notifications cannot be coordinated across your open 0xChat tabs here. Close the other tabs, reload, and enable notifications again.'
export const COORDINATION_CONFLICT =
  'Another 0xChat tab changed notifications while this was running. Check the current setting before trying again.'

export const COORDINATION_TIMEOUT =
  'Notifications did not respond within 30 seconds. Check your connection, then reload 0xChat and try again.'
export const COORDINATION_PENDING =
  'An earlier notification change is still finishing. Wait a minute, then try again.'

export type PushMutationKind = 'explicit' | 'automatic'

// A superseded mutation deliberately carries no value: its result describes
// state the origin has already moved past, so no caller may act on it.
export type PushMutationOutcome<T> =
  | { status: 'ran'; value: T }
  | { status: 'superseded'; message: string }
  | { status: 'blocked'; message: string }
  | { status: 'timedOut'; message: string }

export interface PushClock {
  now: () => number
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

/** Time budget for one action, started before it queues for anything. */
export interface PushDeadline {
  isExpired: () => boolean
  /** Resolves once the budget is spent. */
  expired: Promise<void>
  /** Run `wait` with the clock stopped — for time the user spends in a prompt. */
  untimed: <T>(wait: () => Promise<T>) => Promise<T>
  stop: () => void
}

export interface PushClaim {
  /** True once any newer claim on this origin has been taken. */
  isSuperseded: () => boolean
  /** Conservative ownership check for cleanup without a lock. */
  isSupersededElsewhere: () => boolean
  // True while an exclusive lock guarantees no other tab's mutation is running.
  // Cleanup that infers ownership from absent state is only sound under it.
  serialized: boolean
}

/** The slice of `navigator.locks` the coordinator needs. */
export interface PushLockManager {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>
}

/** The slice of `BroadcastChannel` the coordinator needs. */
export interface PushBroadcast {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  close(): void
}

export interface PushCoordinatorEnv {
  locks?: PushLockManager | null
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  // A factory, unlike the two above: the lock manager and storage are shared
  // origin singletons, while each tab needs a channel of its own to hear the
  // others (a channel never receives what it posted itself).
  broadcast?: () => PushBroadcast | null
  clock?: PushClock
}

export interface MutateOptions<T> {
  kind: PushMutationKind
  run: (claim: PushClaim) => Promise<T>
  // Pass the action's own deadline so queueing before the call counts too.
  deadline?: PushDeadline
}

export interface PushCoordinator {
  mutate<T>(options: MutateOptions<T>): Promise<PushMutationOutcome<T>>
  startDeadline(): PushDeadline
  /** Called when another tab of this origin finished a mutation. */
  onChange(listener: () => void): () => void
  close(): void
}

const browserClock: PushClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function createDeadline(clock: PushClock, ms: number): PushDeadline {
  let remaining = ms
  let since = clock.now()
  let timer: unknown
  let paused = 0
  let done = false
  let fire!: () => void
  const expired = new Promise<void>((resolve) => { fire = resolve })
  const arm = () => {
    since = clock.now()
    timer = clock.setTimeout(() => { done = true; fire() }, Math.max(0, remaining))
  }
  arm()
  return {
    isExpired: () => done,
    expired,
    async untimed(wait) {
      if (!done && paused++ === 0) {
        clock.clearTimeout(timer)
        remaining -= clock.now() - since
      }
      try {
        return await wait()
      } finally {
        if (!done && --paused === 0) arm()
      }
    },
    stop() {
      if (!done) clock.clearTimeout(timer)
    },
  }
}

interface PendingRecord { id: string; at: number }

function browserLocks(): PushLockManager | null {
  const locks = typeof navigator === 'undefined' ? null : navigator.locks
  return locks ? { request: (name, options, callback) => locks.request(name, options, callback) } : null
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // storage can be blocked outright; treat it as uncoordinated
  }
}

function browserBroadcast(): PushBroadcast | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME)
}

export function createPushCoordinator(env: PushCoordinatorEnv = {}): PushCoordinator {
  const locks = env.locks === undefined ? browserLocks() : env.locks
  const storage = env.storage === undefined ? browserStorage() : env.storage
  const channel = (env.broadcast ?? browserBroadcast)()
  const clock = env.clock ?? browserClock
  const listeners = new Set<() => void>()
  // Without a lock we can still order this tab's own side effects.
  let tail: Promise<unknown> = Promise.resolve()
  let local = 0
  let lastClaimed: number | null = null

  // Set iteration tolerates a listener unsubscribing itself mid-dispatch.
  channel?.addEventListener('message', () => { for (const listener of listeners) listener() })

  // `null` means the shared generation is unreadable here, never that it is 0:
  // an unreadable generation must not be mistaken for someone else's claim.
  function readShared(): number | null {
    if (!storage) return null
    try {
      const stored = Number(storage.getItem(GENERATION_KEY))
      return Number.isFinite(stored) ? stored : 0
    } catch {
      return null
    }
  }

  // The pending record names the operation that may still have a native
  // browser call outstanding. It is written and cleared under the lock, so a
  // record found by the next lock holder belongs to a tab that died mid-flight.
  // Without a lock, concurrent explicit actions are allowed and fenced by the
  // shared generation and server revisions instead, so no record is kept.
  function readPending(): PendingRecord | null {
    if (!locks) return null
    try {
      const record = JSON.parse(storage?.getItem(PENDING_KEY) ?? 'null') as PendingRecord | null
      return record && typeof record.id === 'string' && Number.isFinite(record.at) ? record : null
    } catch {
      return null
    }
  }
  function writePending(record: PendingRecord | null) {
    if (!locks) return
    try {
      storage?.setItem(PENDING_KEY, record ? JSON.stringify(record) : '')
    } catch {
      // Unwritable storage leaves ordering to the lock and server revisions.
    }
  }

  function claim(): PushClaim {
    const mine = ++local
    const shared = readShared()
    let claimed: number | null = null
    try {
      if (shared !== null && storage) {
        storage.setItem(GENERATION_KEY, String(shared + 1))
        claimed = shared + 1
      }
    } catch {
      // A rejected write leaves cross-tab ordering to the lock alone.
    }
    // A gap in this tab's sequence means another tab claimed between our
    // claims. Do not mistake a later claim from this same tab for that case.
    const externalBefore = claimed === null || (lastClaimed !== null && claimed !== lastClaimed + 1)
    lastClaimed = claimed
    return {
      serialized: !!locks,
      isSupersededElsewhere: () => {
        const current = readShared()
        return externalBefore || current === null || claimed === null ||
          current !== claimed + (local - mine) || current !== lastClaimed
      },
      isSuperseded: () => {
        if (mine !== local) return true
        if (claimed === null) return false
        const current = readShared()
        return current !== null && current !== claimed
      },
    }
  }

  return {
    startDeadline: () => createDeadline(clock, PUSH_TIMEOUT_MS),
    async mutate<T>(options: MutateOptions<T>) {
      // Automatic work never competes for ownership: without both the lock and
      // the shared generation it stops and asks for a deliberate recovery.
      if (options.kind === 'automatic' && !(locks && storage))
        return { status: 'blocked', message: COORDINATION_UNAVAILABLE } as PushMutationOutcome<T>

      const deadline = options.deadline ?? createDeadline(clock, PUSH_TIMEOUT_MS)
      const claimed = claim()
      let timedOut = false
      const execute = async (): Promise<PushMutationOutcome<T>> => {
        // Expired while queued: the caller has gone, so start nothing native.
        if (deadline.isExpired()) return { status: 'timedOut', message: COORDINATION_TIMEOUT }
        const id = crypto.randomUUID()
        try {
          const pending = readPending()
          if (pending && clock.now() - pending.at < PENDING_TTL_MS)
            return { status: 'blocked', message: COORDINATION_PENDING }
          writePending({ id, at: clock.now() })
          const value = await options.run(claimed)
          return claimed.isSuperseded()
            ? { status: 'superseded', message: COORDINATION_CONFLICT }
            : { status: 'ran', value }
        } finally {
          if (readPending()?.id === id) writePending(null)
          channel?.postMessage({ type: 'push-state-changed' })
          // A late settlement also changes what this tab should show.
          if (timedOut) for (const listener of listeners) listener()
        }
      }
      let settled: Promise<PushMutationOutcome<T>>
      if (locks) {
        settled = locks.request(LOCK_NAME, { mode: 'exclusive' }, execute)
      } else {
        // Chain on the real settlement, not the caller's release, so this
        // tab's next mutation still waits for a stalled one.
        settled = tail.then(execute)
        tail = settled.catch(() => undefined)
      }
      // Release the caller at the deadline without releasing the lock: the
      // work keeps its ownership until the browser promise really settles.
      const expired = deadline.expired.then((): PushMutationOutcome<T> => {
        timedOut = true
        settled.catch(() => undefined)
        return { status: 'timedOut', message: COORDINATION_TIMEOUT }
      })
      try {
        return await Promise.race([settled, expired])
      } finally {
        if (!options.deadline) deadline.stop()
      }
    },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close() {
      listeners.clear()
      channel?.close()
    },
  }
}

let shared: PushCoordinator | undefined

/** The origin's coordinator. Tests open their own to model separate tabs. */
export function pushCoordinator(): PushCoordinator {
  return (shared ??= createPushCoordinator())
}
