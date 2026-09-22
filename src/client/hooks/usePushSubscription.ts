import { useEffect, useState, useRef } from 'preact/hooks'
import { api } from '../lib/api'
import { enablePushSlot, getPushSlotState, releaseSupersededSlot, rememberPushDisabled, removePushSlot, removeRemotePushSlot } from '../lib/push-slots'
import type { PushSlotSummary } from '../../shared/push-slot'
import { runSubscribeOp, runUnsubscribeOp } from '../lib/push-ops'
import { createSerialQueue, claimGeneration } from '../lib/push-queue'
import { pushCoordinator, type PushCoordinator, type PushMutationOutcome } from '../lib/push-coordinator'

function pushApisAvailable(): boolean {
  return 'serviceWorker' in navigator && typeof window.PushManager !== 'undefined' && typeof Notification !== 'undefined'
}

// What one attempt — a mutation, or the session-start read — may still commit.
interface PushAttempt {
  address: string
  token: string
  supported: boolean
  isStale: () => boolean
  // Set once the operation has explained a failure in its own words, so the
  // generic conflict message does not talk over it.
  reported: boolean
}

// Keep the per-hook queue/generation contract, and run every mutation through
// the origin's coordinator so other tabs cannot own the same subscription at
// the same time. Session start only reads owned state; automatic uploads and
// repair remain disabled until #85 lands bounded waiting.
export function usePushSubscription(token: string | null, address: string | null, coordinator?: PushCoordinator) {
  const [supported, setSupported] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [removable, setRemovable] = useState(false)
  const [slots, setSlots] = useState<PushSlotSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [permission, setPermission] = useState<NotificationPermission | null>(
    typeof Notification === 'undefined' ? null : Notification.permission,
  )
  const generationRef = useRef(0)
  const queueRef = useRef(createSerialQueue())
  const tabs = coordinator ?? pushCoordinator()

  // Re-read what the browser and the server actually hold. This is the only
  // path that decides `subscribed`, so a change made in another tab converges
  // here instead of being inferred from this tab's last action.
  const readState = async (attempt: PushAttempt) => {
    try {
      let sub: PushSubscription | null = null
      if (attempt.supported) {
        const reg = await navigator.serviceWorker.ready
        if (attempt.isStale()) return
        sub = await reg.pushManager.getSubscription()
        if (attempt.isStale()) return
      }
      const state = await getPushSlotState(attempt.address, attempt.token)
      if (attempt.isStale()) return
      setSubscribed(!!sub && state.enabled)
      setSlots(state.slots)
      setRemovable(attempt.supported)
    } catch {
      if (attempt.isStale()) return
      setSubscribed(false)
      setSlots([])
      setRemovable(true)
      setError('Could not connect notifications. Try enabling them again.')
    }
  }

  // Claim this tab's next mutation generation. The coordinator adds the shared
  // one; both must be current for the attempt to commit anything.
  const beginAttempt = (activeAddress: string, activeToken: string): PushAttempt =>
    ({ address: activeAddress, token: activeToken, supported, isStale: claimGeneration(generationRef), reported: false })

  // Apply a coordinated mutation's outcome: converge on authoritative state,
  // then surface a conflict the operation itself did not explain. A conflict is
  // reported, never resolved by guessing, and never marks notifications on.
  const finish = async (attempt: PushAttempt, outcome: PushMutationOutcome<unknown>) => {
    if (attempt.isStale()) return
    if (outcome.status === 'blocked') {
      setError(outcome.message)
      return
    }
    await readState(attempt)
    if (outcome.status === 'superseded' && !attempt.reported && !attempt.isStale()) setError(outcome.message)
  }

  useEffect(() => {
    const isSupported = pushApisAvailable()
    setSupported(isSupported)
    setSubscribed(false)
    setRemovable(false)
    setSlots([])
    if (!token || !address) return
    const activeToken = token
    const activeAddress = address
    // Reads are invalidated by this identity going away, not by this tab's own
    // mutations: the queue already orders them, and a mutation must not make
    // the tab deaf to the next change another tab broadcasts.
    let active = true
    const attempt: PushAttempt = { address: activeAddress, token: activeToken, supported: isSupported,
      isStale: () => !active, reported: false }
    const refresh = () => queueRef.current.enqueue(() => readState(attempt))
    refresh()
    const stopListening = tabs.onChange(() => { if (active) refresh() })

    return () => {
      active = false
      generationRef.current++
      stopListening()
    }
  }, [token, address])

  const subscribe = async (): Promise<boolean> => {
    if (!supported || !token || !address) return false
    setError(null)
    const attempt = beginAttempt(address, token)

    return queueRef.current.enqueue(async () => {
      const outcome = await tabs.mutate({
        kind: 'explicit',
        run: (claim) => {
          const stale = () => attempt.isStale() || claim.isSuperseded()
          return runSubscribeOp({
            isStale: stale,
            ready: () => navigator.serviceWorker.ready.then((reg) => reg.pushManager),
            requestPermission: () => Notification.requestPermission(),
            getVapidPublicKey: async () => (await api.getVapidPublicKey()).publicKey,
            upload: (sub) => enablePushSlot(attempt.address, attempt.token, sub, stale),
            releaseIfOwned: (written) => releaseSupersededSlot(attempt.address, attempt.token, written, claim.serialized),
            setPermission,
            setSubscribed,
            setError: (message) => { attempt.reported = true; setError(message) },
          })
        },
      })
      await finish(attempt, outcome)
      return outcome.status === 'ran' && outcome.value
    })
  }

  const removeSlot = async (slot: PushSlotSummary): Promise<void> => {
    if (!token || !address) return
    setError(null)
    const attempt = beginAttempt(address, token)
    return queueRef.current.enqueue(async () => {
      const outcome = await tabs.mutate({
        kind: 'explicit',
        run: async (claim) => {
          const stale = () => attempt.isStale() || claim.isSuperseded()
          if (stale()) return
          try {
            const removedCurrentInstallation = await removeRemotePushSlot(attempt.address, attempt.token, slot)
            if (stale()) return
            setSlots(slots => slots.filter(current => current.slot_id !== slot.slot_id))
            if (removedCurrentInstallation) setSubscribed(false)
          } catch {
            if (stale()) return
            attempt.reported = true
            setError('Could not remove this notification slot. Refresh and try again.')
          }
        },
      })
      await finish(attempt, outcome)
    })
  }

  const unsubscribe = async (): Promise<void> => {
    if (!supported || !token || !address) return
    setError(null)
    try {
      rememberPushDisabled(address)
    } catch {
      setError('Could not remember notifications are off. Check browser storage and retry disabling.')
    }
    setSubscribed(false)
    const attempt = beginAttempt(address, token)

    return queueRef.current.enqueue(async () => {
      const outcome = await tabs.mutate({
        kind: 'explicit',
        run: (claim) => {
          const stale = () => attempt.isStale() || claim.isSuperseded()
          return runUnsubscribeOp({
            isStale: stale,
            ready: () => navigator.serviceWorker.ready.then((reg) => reg.pushManager),
            removeSlot: () => removePushSlot(attempt.address, attempt.token, stale),
            setSubscribed,
            setError: (message) => { attempt.reported = true; setError(message) },
          })
        },
      })
      await finish(attempt, outcome)
    })
  }

  return { supported, subscribed, removable, slots, permission, error, subscribe, unsubscribe, removeSlot }
}
