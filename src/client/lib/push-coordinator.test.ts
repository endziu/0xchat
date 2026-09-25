import { afterEach, expect, test } from 'bun:test'
import {
  COORDINATION_CONFLICT,
  COORDINATION_PENDING,
  COORDINATION_TIMEOUT,
  COORDINATION_UNAVAILABLE,
  PENDING_TTL_MS,
  PUSH_TIMEOUT_MS,
  createPushCoordinator,
  type PushBroadcast,
  type PushCoordinator,
  type PushLockManager,
} from './push-coordinator'
import { createClock, createLockManager, deferred, isSettled } from './push-coordination.test-utils'

// One origin: every "tab" shares the storage that holds the shared generation,
// the lock manager, and the broadcast channel name, exactly as real tabs do.
function createOrigin(options: { locks?: PushLockManager | null; storage?: boolean } = {}) {
  const clock = createClock()
  const channelName = `push-coordinator-test-${crypto.randomUUID()}`
  const entries = new Map<string, string>()
  const storage = options.storage === false ? null : {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value) },
  }
  let locks = options.locks === undefined ? createLockManager() : options.locks
  const open = (): PushCoordinator => {
    const coordinator = createPushCoordinator({
      locks,
      storage,
      clock,
      broadcast: () => new BroadcastChannel(channelName) as PushBroadcast,
    })
    opened.push(coordinator)
    return coordinator
  }
  // A reload drops every lock the old page held, as a real browser does.
  const reload = () => { locks = createLockManager() }
  return { open, reload, clock }
}

const opened: PushCoordinator[] = []
afterEach(() => {
  for (const coordinator of opened.splice(0)) coordinator.close()
})

test('mutations from two tabs take turns instead of overlapping', async () => {
  const origin = createOrigin()
  const first = origin.open()
  const second = origin.open()
  const trace: string[] = []
  const body = (tab: string) => async () => {
    trace.push(`${tab}:start`)
    await Bun.sleep(5)
    trace.push(`${tab}:end`)
  }

  await Promise.all([
    first.mutate({ kind: 'explicit', run: body('first') }),
    second.mutate({ kind: 'explicit', run: body('second') }),
  ])

  expect(trace).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
})

test('a newer claim in another tab supersedes an operation already running', async () => {
  const origin = createOrigin()
  const first = origin.open()
  const second = origin.open()
  const released = deferred()
  let supersededDuringRun = false

  const running = first.mutate({
    kind: 'explicit',
    run: async (claim) => {
      await released.promise
      supersededDuringRun = claim.isSuperseded()
      return 'first'
    },
  })
  // The second tab claims while the first is still in flight; it only starts
  // once the lock is free, but its claim is what makes the first one stale.
  const queued = second.mutate({ kind: 'explicit', run: async (claim) => claim.isSuperseded() })
  released.resolve()

  const [older, newer] = await Promise.all([running, queued])
  expect(supersededDuringRun).toBe(true)
  expect(older).toEqual({ status: 'superseded', message: COORDINATION_CONFLICT })
  expect(newer).toEqual({ status: 'ran', value: false })
})

test('a tab that finishes a mutation tells the other tabs to re-read state', async () => {
  const origin = createOrigin()
  const acting = origin.open()
  const watching = origin.open()
  let notified = 0
  const stop = watching.onChange(() => { notified++ })

  await acting.mutate({ kind: 'explicit', run: async () => undefined })
  await Bun.sleep(5)
  expect(notified).toBe(1)

  // The acting tab never notifies itself: it already re-reads its own result.
  const self = deferred()
  acting.onChange(() => self.resolve())
  let selfNotified = false
  void self.promise.then(() => { selfNotified = true })
  await acting.mutate({ kind: 'explicit', run: async () => undefined })
  await Bun.sleep(5)
  expect(selfNotified).toBe(false)

  stop()
  await acting.mutate({ kind: 'explicit', run: async () => undefined })
  await Bun.sleep(5)
  expect(notified).toBe(2)
})

test('automatic mutation is refused with recovery when no browser lock is available', async () => {
  for (const origin of [createOrigin({ locks: null }), createOrigin({ storage: false })]) {
    const tab = origin.open()
    let ran = false

    const outcome = await tab.mutate({ kind: 'automatic', run: async () => { ran = true } })

    expect(outcome).toEqual({ status: 'blocked', message: COORDINATION_UNAVAILABLE })
    expect(ran).toBe(false)
  }
})

test('explicit actions still run when the shared generation is unavailable', async () => {
  const tab = createOrigin({ storage: false }).open()
  let claimedSerialized = false

  const outcome = await tab.mutate({ kind: 'explicit', run: async (claim) => {
    claimedSerialized = claim.serialized
    // An unreadable shared generation is not another tab's claim.
    return claim.isSuperseded()
  } })

  expect(outcome).toEqual({ status: 'ran', value: false })
  expect(claimedSerialized).toBe(true)
})

test('a claim reports whether an exclusive lock is backing it', async () => {
  const locked = await createOrigin().open()
    .mutate({ kind: 'explicit', run: async (claim) => claim.serialized })
  const unlocked = await createOrigin({ locks: null }).open()
    .mutate({ kind: 'explicit', run: async (claim) => claim.serialized })

  expect(locked).toEqual({ status: 'ran', value: true })
  expect(unlocked).toEqual({ status: 'ran', value: false })
})

test('explicit actions still run without a browser lock, serialized within the tab', async () => {
  const origin = createOrigin({ locks: null })
  const tab = origin.open()
  const trace: string[] = []

  const [first, second] = await Promise.all([
    tab.mutate({ kind: 'explicit', run: async () => {
      trace.push('first:start')
      await Bun.sleep(5)
      trace.push('first:end')
    } }),
    tab.mutate({ kind: 'explicit', run: async (claim) => {
      trace.push('second:start')
      return claim.isSuperseded()
    } }),
  ])

  expect(trace).toEqual(['first:start', 'first:end', 'second:start'])
  expect(first.status).toBe('superseded')
  expect(second).toEqual({ status: 'ran', value: false })
})

test('a failing mutation releases the lock and still announces the change', async () => {
  const origin = createOrigin()
  const acting = origin.open()
  const watching = origin.open()
  let notified = 0
  watching.onChange(() => { notified++ })

  await expect(acting.mutate({ kind: 'explicit', run: async () => { throw new Error('offline') } }))
    .rejects.toThrow('offline')
  const after = await acting.mutate({ kind: 'explicit', run: async () => 'recovered' })

  expect(after).toEqual({ status: 'ran', value: 'recovered' })
  await Bun.sleep(5)
  expect(notified).toBe(2)
})

test('a timed-out mutation releases its caller but holds the lock until the work settles', async () => {
  const origin = createOrigin()
  const stalled = origin.open()
  const waiting = origin.open()
  const native = deferred()
  let lateNotice = 0
  stalled.onChange(() => { lateNotice++ })

  const first = stalled.mutate({ kind: 'explicit', run: async () => { await native.promise } })
  await Bun.sleep(5)
  origin.clock.advance(PUSH_TIMEOUT_MS)
  expect(await first).toEqual({ status: 'timedOut', message: COORDINATION_TIMEOUT })

  // The underlying browser call is still running, so nobody else may start.
  let started = false
  const second = waiting.mutate({ kind: 'explicit', run: async () => { started = true } })
  expect(await isSettled(second)).toBe(false)
  expect(started).toBe(false)

  native.resolve()
  expect(await second).toEqual({ status: 'ran', value: undefined })
  expect(started).toBe(true)
  // The timed-out tab re-reads state once its late work has settled.
  expect(lateNotice).toBe(1)
})

test('a mutation that expires while queued never starts', async () => {
  const origin = createOrigin()
  const holder = origin.open()
  const queued = origin.open()
  const native = deferred()
  let started = false

  const held = holder.mutate({ kind: 'explicit', run: async () => { await native.promise } })
  const later = queued.mutate({ kind: 'explicit', run: async () => { started = true } })
  await Bun.sleep(5)
  origin.clock.advance(PUSH_TIMEOUT_MS)
  expect(await later).toEqual({ status: 'timedOut', message: COORDINATION_TIMEOUT })

  native.resolve()
  await held
  await Bun.sleep(5)
  expect(started).toBe(false)
})

test('time spent in the permission prompt does not count toward the deadline', async () => {
  const origin = createOrigin()
  const tab = origin.open()
  const prompt = deferred()
  const native = deferred()
  const deadline = tab.startDeadline()
  origin.clock.advance(10_000) // spent queued before the operation began

  const outcome = tab.mutate({ kind: 'explicit', deadline, run: async () => {
    await deadline.untimed(() => prompt.promise)
    await native.promise
  } })
  await Bun.sleep(5)
  origin.clock.advance(5 * 60_000)
  expect(await isSettled(outcome)).toBe(false)

  prompt.resolve()
  await Bun.sleep(5)
  origin.clock.advance(PUSH_TIMEOUT_MS - 10_001)
  expect(await isSettled(outcome)).toBe(false)
  origin.clock.advance(1)
  expect(await outcome).toEqual({ status: 'timedOut', message: COORDINATION_TIMEOUT })
  native.resolve()
})

test('a tab reloaded mid-operation defers the next mutation until its record expires', async () => {
  const origin = createOrigin()
  const dying = origin.open()
  const stalled = dying.mutate({ kind: 'explicit', run: () => new Promise(() => {}) })
  await Bun.sleep(5)
  origin.clock.advance(PUSH_TIMEOUT_MS)
  expect((await stalled).status).toBe('timedOut')

  origin.reload()
  const reloaded = origin.open()
  let ran = false
  const run = async () => { ran = true }
  expect(await reloaded.mutate({ kind: 'explicit', run })).toEqual({ status: 'blocked', message: COORDINATION_PENDING })
  expect(ran).toBe(false)

  origin.clock.advance(PENDING_TTL_MS - PUSH_TIMEOUT_MS)
  expect(await reloaded.mutate({ kind: 'explicit', run })).toEqual({ status: 'ran', value: undefined })
  expect(ran).toBe(true)
})
