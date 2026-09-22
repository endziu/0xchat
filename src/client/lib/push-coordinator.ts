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

const GENERATION_KEY = '0xchat.push.generation'
const LOCK_NAME = '0xchat.push.subscription'
const CHANNEL_NAME = '0xchat.push'

export const COORDINATION_UNAVAILABLE =
  'Notifications cannot be coordinated across your open 0xChat tabs here. Close the other tabs, reload, and enable notifications again.'
export const COORDINATION_CONFLICT =
  'Another 0xChat tab changed notifications while this was running. Check the current setting before trying again.'

export type PushMutationKind = 'explicit' | 'automatic'

// A superseded mutation deliberately carries no value: its result describes
// state the origin has already moved past, so no caller may act on it.
export type PushMutationOutcome<T> =
  | { status: 'ran'; value: T }
  | { status: 'superseded'; message: string }
  | { status: 'blocked'; message: string }

export interface PushClaim {
  /** True once any newer claim on this origin has been taken. */
  isSuperseded: () => boolean
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
}

export interface PushCoordinator {
  mutate<T>(options: { kind: PushMutationKind; run: (claim: PushClaim) => Promise<T> }): Promise<PushMutationOutcome<T>>
  /** Called when another tab of this origin finished a mutation. */
  onChange(listener: () => void): () => void
  close(): void
}

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
  const listeners = new Set<() => void>()
  // Without a lock we can still order this tab's own side effects.
  let tail: Promise<unknown> = Promise.resolve()
  let local = 0

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
    return {
      serialized: !!locks,
      isSuperseded: () => {
        if (mine !== local) return true
        if (claimed === null) return false
        const current = readShared()
        return current !== null && current !== claimed
      },
    }
  }

  return {
    async mutate<T>(options: { kind: PushMutationKind; run: (claim: PushClaim) => Promise<T> }) {
      // Automatic work never competes for ownership: without both the lock and
      // the shared generation it stops and asks for a deliberate recovery.
      if (options.kind === 'automatic' && !(locks && storage))
        return { status: 'blocked', message: COORDINATION_UNAVAILABLE } as PushMutationOutcome<T>

      const claimed = claim()
      const execute = async (): Promise<PushMutationOutcome<T>> => {
        try {
          const value = await options.run(claimed)
          return claimed.isSuperseded()
            ? { status: 'superseded', message: COORDINATION_CONFLICT }
            : { status: 'ran', value }
        } finally {
          channel?.postMessage({ type: 'push-state-changed' })
        }
      }
      if (locks) return locks.request(LOCK_NAME, { mode: 'exclusive' }, execute)
      const result = tail.then(execute)
      tail = result.catch(() => undefined)
      return result
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
