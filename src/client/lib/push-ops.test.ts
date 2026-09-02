import { describe, expect, test } from 'bun:test'
import { ApiError } from './api'
import { runSubscribeOp, runUnsubscribeOp, type SubscribeOpDeps, type UnsubscribeOpDeps } from './push-ops'

interface State {
  permission: NotificationPermission | null
  subscribed: boolean
  errors: string[]
  uploads: PushSubscriptionJSON[]
  deletes: string[]
  unsubscribed: number
}

function makeState(): State {
  return { permission: null, subscribed: false, errors: [], uploads: [], deletes: [], unsubscribed: 0 }
}

function makeSub(state: State, endpoint = 'ep-sub'): PushSubscription {
  const json: PushSubscriptionJSON = { endpoint, expirationTime: null, keys: {} }
  return {
    endpoint,
    toJSON: () => json,
    unsubscribe: async () => {
      state.unsubscribed++
      return true
    },
  } as unknown as PushSubscription
}

function subscribeDeps(
  state: State,
  hooks: {
    stale: () => boolean
    beforeVapid?: () => void | Promise<void>
    beforeSubscribe?: () => void | Promise<void>
    duringUpload?: () => void | Promise<void>
    beforeReady?: () => void | Promise<void>
    permission?: NotificationPermission
  },
): SubscribeOpDeps {
  const sub = makeSub(state)
  return {
    isStale: hooks.stale,
    ready: async () => {
      await hooks.beforeReady?.()
      return {
        subscribe: async () => {
          await hooks.beforeSubscribe?.()
          return sub
        },
        getSubscription: async () => sub,
      }
    },
    requestPermission: async () => hooks.permission ?? 'granted',
    getVapidPublicKey: async () => {
      await hooks.beforeVapid?.()
      return 'A'.repeat(44)
    },
    upload: async (s) => {
      state.uploads.push(s)
      await hooks.duringUpload?.()
    },
    setPermission: (p) => {
      state.permission = p
    },
    setSubscribed: (b) => {
      state.subscribed = b
    },
    setError: (m) => {
      state.errors.push(m)
    },
  }
}

function unsubscribeDeps(
  state: State,
  hooks: {
    stale: () => boolean
    ready?: UnsubscribeOpDeps['ready']
    beforeGetSubscription?: () => void | Promise<void>
    beforeDelete?: () => void | Promise<void>
    sub?: PushSubscription | null
  },
): UnsubscribeOpDeps {
  const sub = hooks.sub === undefined ? makeSub(state) : hooks.sub
  return {
    isStale: hooks.stale,
    ready: hooks.ready ??
      (async () => ({
        subscribe: async () => sub as PushSubscription,
        getSubscription: async () => {
          await hooks.beforeGetSubscription?.()
          return sub
        },
      })),
    deleteEndpoint: async (endpoint) => {
      await hooks.beforeDelete?.()
      state.deletes.push(endpoint)
    },
    setSubscribed: (b) => {
      state.subscribed = b
    },
    setError: (m) => {
      state.errors.push(m)
    },
  }
}

function makeStale(): { stale: () => boolean; go: () => void } {
  let stale = false
  return { stale: () => stale, go: () => (stale = true) }
}

describe('runSubscribeOp', () => {
  test('happy path: prompts, subscribes, uploads, marks subscribed', async () => {
    const state = makeState()
    const ok = await runSubscribeOp(subscribeDeps(state, { stale: () => false }))
    expect(ok).toBe(true)
    expect(state.uploads).toEqual([{ endpoint: 'ep-sub', expirationTime: null, keys: {} }])
    expect(state.subscribed).toBe(true)
    expect(state.permission).toBe('granted')
    expect(state.errors).toEqual([])
    expect(state.unsubscribed).toBe(0)
  })

  test('superseded while awaiting service-worker readiness: no sub created, no writes', async () => {
    const state = makeState()
    const gen = makeStale()
    const ok = await runSubscribeOp(subscribeDeps(state, { stale: gen.stale, beforeReady: gen.go }))
    expect(ok).toBe(false)
    expect(state.uploads).toEqual([])
    expect(state.subscribed).toBe(false)
    expect(state.unsubscribed).toBe(0)
  })

  test('superseded after sub creation, before upload: browser sub removed, nothing uploaded', async () => {
    const state = makeState()
    const gen = makeStale()
    const ok = await runSubscribeOp(subscribeDeps(state, { stale: gen.stale, beforeSubscribe: gen.go }))
    expect(ok).toBe(false)
    expect(state.uploads).toEqual([])
    expect(state.subscribed).toBe(false)
    expect(state.unsubscribed).toBe(1)
  })

  test('regression: superseded DURING api.subscribePush — browser sub still removed', async () => {
    const state = makeState()
    const gen = makeStale()
    const deps = subscribeDeps(state, { stale: gen.stale })
    // An identity switch / token clear lands while the upload is still in
    // flight (after it has been issued, before it resolves).
    deps.upload = async (s) => {
      state.uploads.push(s)
      await new Promise((r) => setTimeout(r, 0))
      gen.go()
    }
    const ok = await runSubscribeOp(deps)
    expect(ok).toBe(false)
    expect(state.uploads).toHaveLength(1)
    expect(state.subscribed).toBe(false)
    expect(state.unsubscribed).toBe(1)
  })

  test('permission denied: error set, no subscription created', async () => {
    const state = makeState()
    const ok = await runSubscribeOp(subscribeDeps(state, { stale: () => false, permission: 'denied' }))
    expect(ok).toBe(false)
    expect(state.errors).toEqual(['Notification permission was not granted.'])
    expect(state.uploads).toEqual([])
    expect(state.unsubscribed).toBe(0)
  })

  test('unsupported push service gets an actionable message without suggesting retry', async () => {
    const state = makeState()
    const deps = subscribeDeps(state, { stale: () => false })
    deps.upload = async () => {
      throw new ApiError('Unsupported push service', 'unsupported_push_service')
    }

    const ok = await runSubscribeOp(deps)

    expect(ok).toBe(false)
    expect(state.errors).toEqual([
      "This browser's push service is not supported. Try an official Chrome, Firefox, Safari, or Edge build.",
    ])
  })

  test('transport and generic server failures keep the retry message', async () => {
    const state = makeState()
    const deps = subscribeDeps(state, { stale: () => false })
    deps.upload = async () => { throw new Error('network unavailable') }

    const ok = await runSubscribeOp(deps)

    expect(ok).toBe(false)
    expect(state.errors).toEqual(['Could not enable notifications. Please try again.'])
  })
})

describe('runUnsubscribeOp', () => {
  test('happy path: server delete + browser unsubscribe + state cleared', async () => {
    const state = makeState()
    state.subscribed = true
    await runUnsubscribeOp(unsubscribeDeps(state, { stale: () => false }))
    expect(state.deletes).toEqual(['ep-sub'])
    expect(state.unsubscribed).toBe(1)
    expect(state.subscribed).toBe(false)
    expect(state.errors).toEqual([])
  })

  test('no browser subscription: no writes, state cleared', async () => {
    const state = makeState()
    await runUnsubscribeOp(unsubscribeDeps(state, { stale: () => false, sub: null }))
    expect(state.deletes).toEqual([])
    expect(state.unsubscribed).toBe(0)
    expect(state.subscribed).toBe(false)
  })

  test('regression: superseded while awaiting service-worker readiness — local cleanup still completes', async () => {
    const state = makeState()
    state.subscribed = true
    const gen = makeStale()
    const deps = unsubscribeDeps(state, {
      stale: gen.stale,
      ready: async () => {
        // A newer generation (token change) claims while this op waits for the SW.
        gen.go()
        return {
          subscribe: async () => {
            throw new Error('unused')
          },
          getSubscription: async () => makeSub(state),
        }
      },
    })
    await runUnsubscribeOp(deps)
    // Server write skipped, but the browser sub must be dropped; state is
    // left to the newer generation (stale op must not touch it).
    expect(state.deletes).toEqual([])
    expect(state.unsubscribed).toBe(1)
    expect(state.subscribed).toBe(true)
  })

  test('regression: superseded during subscription lookup — browser sub still dropped', async () => {
    const state = makeState()
    state.subscribed = true
    const gen = makeStale()
    const deps = unsubscribeDeps(state, { stale: gen.stale, beforeGetSubscription: gen.go })
    await runUnsubscribeOp(deps)
    expect(state.deletes).toEqual([])
    expect(state.unsubscribed).toBe(1)
    expect(state.subscribed).toBe(true)
  })

  test('superseded after server write: browser unsubscribe still completes', async () => {
    const state = makeState()
    state.subscribed = true
    const gen = makeStale()
    const deps = unsubscribeDeps(state, { stale: gen.stale, beforeDelete: gen.go })
    await runUnsubscribeOp(deps)
    expect(state.deletes).toEqual(['ep-sub'])
    expect(state.unsubscribed).toBe(1)
    expect(state.subscribed).toBe(true)
  })
})
