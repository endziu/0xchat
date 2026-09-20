import { useEffect, useState, useRef } from 'preact/hooks'
import { api } from '../lib/api'
import { checkPushSlot, enablePushSlot, rememberPushDisabled, removePushSlot } from '../lib/push-slots'
import { runSubscribeOp, runUnsubscribeOp } from '../lib/push-ops'
import { createSerialQueue, claimGeneration } from '../lib/push-queue'

// Keep the per-hook queue/generation contract. Session start only reads owned
// state; automatic uploads/repair remain disabled until the cross-tab coordinator.
export function usePushSubscription(token: string | null, address: string | null) {
  const [supported, setSupported] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [removable, setRemovable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [permission, setPermission] = useState<NotificationPermission | null>(
    typeof Notification === 'undefined' ? null : Notification.permission,
  )
  const generationRef = useRef(0)
  const queueRef = useRef(createSerialQueue())

  useEffect(() => {
    const isSupported = 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined'
    setSupported(isSupported)
    setSubscribed(false)
    setRemovable(false)
    if (!isSupported || !token || !address) return
    const activeToken = token
    const activeAddress = address
    const isStale = claimGeneration(generationRef)

    queueRef.current.enqueue(async () => {
      try {
        const reg = await navigator.serviceWorker.ready
        if (isStale()) return
        const sub = await reg.pushManager.getSubscription()
        if (isStale()) return
        const enabled = await checkPushSlot(activeAddress, activeToken)
        if (!isStale()) {
          setSubscribed(!!sub && enabled)
          setRemovable(true)
        }
      } catch {
        if (!isStale()) {
          setSubscribed(false)
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

    return queueRef.current.enqueue(() =>
      runSubscribeOp({
        isStale,
        ready: () => navigator.serviceWorker.ready.then((reg) => reg.pushManager),
        requestPermission: () => Notification.requestPermission(),
        getVapidPublicKey: async () => (await api.getVapidPublicKey()).publicKey,
        upload: (sub) => enablePushSlot(address, activeToken, sub, isStale),
        setPermission,
        setSubscribed,
        setError,
      }),
    )
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

    return queueRef.current.enqueue(() =>
      runUnsubscribeOp({
        isStale,
        ready: () => navigator.serviceWorker.ready.then((reg) => reg.pushManager),
        removeSlot: () => removePushSlot(address, activeToken, isStale),
        setSubscribed,
        setError,
      }),
    )
  }

  return { supported, subscribed, removable, permission, error, subscribe, unsubscribe }
}
