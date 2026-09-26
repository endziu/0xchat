import { describe, expect, test } from 'bun:test'
import { ApiError } from './api'
import { runSubscribeOp, urlBase64ToUint8Array, runUnsubscribeOp, type SubscribeOpDeps, type UnsubscribeOpDeps } from './push-ops'

interface State {
  permission: NotificationPermission | null
  subscribed: boolean
  errors: string[]
  uploads: PushSubscriptionJSON[]
  deletes: string[]
  unsubscribed: number
  subscribes: number
  releases: number
  // What the authoritative server state says a superseded op still owns.
  ownsArtifacts: boolean
}

function makeState(): State {
  return { permission: null, subscribed: false, errors: [], uploads: [], deletes: [], unsubscribed: 0,
    subscribes: 0, releases: 0, ownsArtifacts: true }
}

const CURRENT_KEY = 'A'.repeat(44)

function makeSub(state: State, endpoint = 'ep-sub', key = CURRENT_KEY): PushSubscription {
  const json: PushSubscriptionJSON = { endpoint, expirationTime: null, keys: {} }
  return {
    endpoint,
    options: { applicationServerKey: urlBase64ToUint8Array(key).buffer, userVisibleOnly: true },
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
    beforeGetSubscription?: () => void | Promise<void>
    permission?: NotificationPermission
    // A browser subscription that already exists before this op runs.
    existing?: PushSubscription
  },
): SubscribeOpDeps {
  let existing: PushSubscription | null = null
  // The browser holds one subscription; unsubscribing clears it.
  const hold = (sub: PushSubscription) => {
    const unsubscribe = sub.unsubscribe.bind(sub)
    existing = Object.assign(sub, { unsubscribe: async () => { existing = null; return unsubscribe() } })
    return existing
  }
  if (hooks.existing) hold(hooks.existing)
  return {
    isStale: hooks.stale,
    ready: async () => {
      await hooks.beforeReady?.()
      return {
        // Each native subscribe after an unsubscribe yields a fresh endpoint.
        subscribe: async () => {
          await hooks.beforeSubscribe?.()
          if (existing) return existing
          state.subscribes++
          return hold(makeSub(state, state.subscribes === 1 ? 'ep-sub' : `ep-sub-${state.subscribes}`))
        },
        getSubscription: async () => {
          await hooks.beforeGetSubscription?.()
          return existing
        },
      }
    },
    requestPermission: async () => hooks.permission ?? 'granted',
    getVapidPublicKey: async () => {
      await hooks.beforeVapid?.()
      return CURRENT_KEY
    },
    upload: async (s) => {
      state.uploads.push(s)
      await hooks.duringUpload?.()
    },
    releaseIfOwned: async () => {
      state.releases++
      return state.ownsArtifacts
    },
    mayRemoveBrowser: () => true,
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
    removeSlot: async () => {
      await hooks.beforeDelete?.()
      state.deletes.push('ep-sub')
    },
    mayRemoveBrowser: () => true,
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

  test('superseded completion leaves a registration a newer operation owns', async () => {
    const state = makeState()
    const gen = makeStale()
    // Another tab took the installation's slot over while this op ran, so the
    // authoritative revision no longer matches what this op wrote.
    state.ownsArtifacts = false
    const ok = await runSubscribeOp(subscribeDeps(state, { stale: gen.stale, duringUpload: gen.go }))
    expect(ok).toBe(false)
    expect(state.releases).toBe(1)
    expect(state.unsubscribed).toBe(0)
    expect(state.subscribed).toBe(false)
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

  test('an existing subscription made with another VAPID key is replaced before subscribing', async () => {
    const state = makeState()
    const old = makeSub(state, 'ep-old', 'B'.repeat(44))
    const ok = await runSubscribeOp(subscribeDeps(state, { stale: () => false, existing: old }))
    expect(ok).toBe(true)
    expect(state.unsubscribed).toBe(1)
    expect(state.uploads.map((s) => s.endpoint)).toEqual(['ep-sub'])
    expect(state.errors).toEqual([])
  })

  test('an existing subscription with the current VAPID key is reused', async () => {
    const state = makeState()
    const current = makeSub(state, 'ep-current')
    const ok = await runSubscribeOp(subscribeDeps(state, { stale: () => false, existing: current }))
    expect(ok).toBe(true)
    expect(state.unsubscribed).toBe(0)
    expect(state.uploads.map((s) => s.endpoint)).toEqual(['ep-current'])
  })

  test('an expired attempt leaves a mismatched subscription alone', async () => {
    const state = makeState()
    const gen = makeStale()
    const old = makeSub(state, 'ep-old', 'B'.repeat(44))
    const ok = await runSubscribeOp(subscribeDeps(state, { stale: gen.stale, existing: old, beforeGetSubscription: gen.go }))
    expect(ok).toBe(false)
    expect(state.unsubscribed).toBe(0)
    expect(state.uploads).toEqual([])
  })

  const conflict = () => new ApiError('Remove this browser subscription from its previous identity before enabling it here.',
    'ownership_conflict')

  test('an ownership conflict resubscribes with a fresh endpoint and uploads once more', async () => {
    const state = makeState()
    const deps = subscribeDeps(state, { stale: () => false })
    deps.upload = async (s) => {
      state.uploads.push(s)
      if (state.uploads.length === 1) throw conflict()
    }
    const ok = await runSubscribeOp(deps)
    expect(ok).toBe(true)
    expect(state.uploads.map((s) => s.endpoint)).toEqual(['ep-sub', 'ep-sub-2'])
    expect(state.unsubscribed).toBe(1)
    expect(state.subscribed).toBe(true)
    expect(state.errors).toEqual([])
  })

  test('a second ownership conflict is surfaced without another retry', async () => {
    const state = makeState()
    const deps = subscribeDeps(state, { stale: () => false })
    deps.upload = async (s) => {
      state.uploads.push(s)
      throw conflict()
    }
    const ok = await runSubscribeOp(deps)
    expect(ok).toBe(false)
    expect(state.uploads).toHaveLength(2)
    expect(state.subscribes).toBe(2)
    expect(state.errors).toEqual([conflict().message])
  })

  test('an attempt that expires during a conflicting upload leaves the browser subscription alone', async () => {
    const state = makeState()
    const gen = makeStale()
    const deps = subscribeDeps(state, { stale: gen.stale })
    deps.upload = async (s) => {
      state.uploads.push(s)
      gen.go()
      throw conflict()
    }
    const ok = await runSubscribeOp(deps)
    expect(ok).toBe(false)
    expect(state.uploads).toHaveLength(1)
    expect(state.unsubscribed).toBe(0)
    expect(state.errors).toEqual([])
  })

  test('a conflict is reported, not retried, when the browser subscription is not ours to remove', async () => {
    const state = makeState()
    const deps = subscribeDeps(state, { stale: () => false })
    deps.mayRemoveBrowser = () => false
    deps.upload = async (s) => {
      state.uploads.push(s)
      throw conflict()
    }
    const ok = await runSubscribeOp(deps)
    expect(ok).toBe(false)
    expect(state.uploads).toHaveLength(1)
    expect(state.unsubscribed).toBe(0)
    expect(state.errors).toEqual([conflict().message])
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
  test('reports whether alerts for the identity have stopped on this browser', async () => {
    const offline = (state: State, hooks: Parameters<typeof unsubscribeDeps>[1]) => {
      const deps = unsubscribeDeps(state, hooks)
      deps.removeSlot = async () => { throw new Error('offline') }
      return deps
    }
    const stuck = { endpoint: 'ep-sub', unsubscribe: async () => false } as unknown as PushSubscription

    expect(await runUnsubscribeOp(unsubscribeDeps(makeState(), { stale: () => false }))).toBe(true)
    expect(await runUnsubscribeOp(unsubscribeDeps(makeState(), { stale: () => false, sub: stuck }))).toBe(true)
    expect(await runUnsubscribeOp(offline(makeState(), { stale: () => false }))).toBe(true)
    expect(await runUnsubscribeOp(offline(makeState(), { stale: () => false, sub: null }))).toBe(true)
    expect(await runUnsubscribeOp(offline(makeState(), { stale: () => false, sub: stuck }))).toBe(false)
  })


  test('happy path: server delete + browser unsubscribe + state cleared', async () => {
    const state = makeState()
    state.subscribed = true
    await runUnsubscribeOp(unsubscribeDeps(state, { stale: () => false }))
    expect(state.deletes).toEqual(['ep-sub'])
    expect(state.unsubscribed).toBe(1)
    expect(state.subscribed).toBe(false)
    expect(state.errors).toEqual([])
  })

  test('no browser subscription: owned slot still removed, state cleared', async () => {
    const state = makeState()
    await runUnsubscribeOp(unsubscribeDeps(state, { stale: () => false, sub: null }))
    expect(state.deletes).toEqual(['ep-sub'])
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
