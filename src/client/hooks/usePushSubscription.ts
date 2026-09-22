import { useEffect, useState, useRef } from 'preact/hooks'
import { api } from '../lib/api'
import { enablePushSlot, getPushSlotState, rememberPushDisabled, removePushSlot, removeRemotePushSlot } from '../lib/push-slots'
import type { PushSlotSummary } from '../../shared/push-slot'
import { runSubscribeOp, runUnsubscribeOp } from '../lib/push-ops'
import { createSerialQueue, claimGeneration } from '../lib/push-queue'

// Keep the per-hook queue/generation contract. Session start only reads owned
// state; automatic uploads/repair remain disabled until the cross-tab coordinator.
export function usePushSubscription(token: string | null, address: string | null) {
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

  useEffect(() => {
    const isSupported = 'serviceWorker' in navigator && typeof window.PushManager !== 'undefined' && typeof Notification !== 'undefined'
    setSupported(isSupported)
    setSubscribed(false)
    setRemovable(false)
    setSlots([])
    if (!token || !address) return
    const activeToken = token
    const activeAddress = address
    const isStale = claimGeneration(generationRef)

    queueRef.current.enqueue(async () => {
      try {
        let sub: PushSubscription | null = null
        if (isSupported) {
          const reg = await navigator.serviceWorker.ready
          if (isStale()) return
          sub = await reg.pushManager.getSubscription()
          if (isStale()) return
        }
        const state = await getPushSlotState(activeAddress, activeToken)
        if (!isStale()) {
          setSubscribed(!!sub && state.enabled)
          setSlots(state.slots)
          setRemovable(isSupported)
        }
      } catch {
        if (!isStale()) {
          setSubscribed(false)
          setSlots([])
          setRemovable(true)
          setError('Could not connect notifications. Try enabling them again.')
        }
      }
    })

    return () => { generationRef.current++ }
  }, [token, address])

  const subscribe = async (): Promise<boolean> => {
    if (!supported || !token || !address) return false
    setError(null)
    const isStale = claimGeneration(generationRef)
    const activeToken = token

    return queueRef.current.enqueue(async () => {
      const enabled = await runSubscribeOp({
        isStale,
        ready: () => navigator.serviceWorker.ready.then((reg) => reg.pushManager),
        requestPermission: () => Notification.requestPermission(),
        getVapidPublicKey: async () => (await api.getVapidPublicKey()).publicKey,
        upload: (sub) => enablePushSlot(address, activeToken, sub, isStale),
        setPermission,
        setSubscribed,
        setError,
      })
      if (enabled && !isStale()) {
        const state = await getPushSlotState(address, activeToken)
        if (!isStale()) setSlots(state.slots)
      }
      return enabled
    })
  }

  const removeSlot = async (slot: PushSlotSummary): Promise<void> => {
    if (!token || !address) return
    setError(null)
    const isStale = claimGeneration(generationRef)
    const activeToken = token
    return queueRef.current.enqueue(async () => {
      try {
        if (isStale()) return
        const removedCurrentInstallation = await removeRemotePushSlot(address, activeToken, slot)
        if (!isStale()) {
          setSlots(slots => slots.filter(current => current.slot_id !== slot.slot_id))
          if (removedCurrentInstallation) setSubscribed(false)
        }
      } catch {
        if (!isStale()) setError('Could not remove this notification slot. Refresh and try again.')
      }
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
    const isStale = claimGeneration(generationRef)
    const activeToken = token

    return queueRef.current.enqueue(async () => {
      await runUnsubscribeOp({
        isStale,
        ready: () => navigator.serviceWorker.ready.then((reg) => reg.pushManager),
        removeSlot: () => removePushSlot(address, activeToken, isStale),
        setSubscribed,
        setError,
      })
      if (!isStale()) {
        const state = await getPushSlotState(address, activeToken)
        if (!isStale()) setSlots(state.slots)
      }
    })
  }

  return { supported, subscribed, removable, slots, permission, error, subscribe, unsubscribe, removeSlot }
}
