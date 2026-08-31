import { useEffect, useState, useRef } from 'preact/hooks'
import { api } from '../lib/api'
import { reuploadExistingSubscription } from '../lib/push-reupload'
import { runSubscribeOp, runUnsubscribeOp } from '../lib/push-ops'
import { createSerialQueue, claimGeneration } from '../lib/push-queue'

// Push notifications carry no payload (server design: relay only ever sees a
// bare wakeup, never who messaged whom or what). Unlike SSE, subscribing
// requires an explicit user gesture — browsers block/ignore permission
// prompts not triggered by a click — so this hook never auto-subscribes.
//
// All server-mutating push operations (session-start re-upload, subscribe,
// unsubscribe) are serialized on a single queue and each claims a generation.
// Only the newest generation may perform its server write and update state; a
// superseded operation skips its write when its turn arrives, so a stale
// re-upload can never re-create an endpoint under a previous identity.
// Per-op flows live in push-ops; this hook owns queue, generations, and state.
export function usePushSubscription(token: string | null) {
  const [supported, setSupported] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [permission, setPermission] = useState<NotificationPermission | null>(
    typeof Notification === 'undefined' ? null : Notification.permission,
  )
  const generationRef = useRef(0)
  const queueRef = useRef(createSerialQueue())

  useEffect(() => {
    const isSupported = 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined'
    setSupported(isSupported)
    if (!isSupported || !token) return
    const activeToken: string = token
    const isStale = claimGeneration(generationRef)

    queueRef.current.enqueue(async () => {
      try {
        const reg = await navigator.serviceWorker.ready
        if (isStale()) return
        const result = await reuploadExistingSubscription({
          getSubscription: () => reg.pushManager.getSubscription(),
          upload: (sub) => api.subscribePush(sub, activeToken),
          isStale,
        })
        if (!result.superseded) {
          setSubscribed(result.subscribed)
          setError(null)
        }
      } catch (err) {
        if (!isStale()) {
          setSubscribed(false)
          setError('Could not connect notifications. Try enabling them again.')
        }
        console.error('Push subscription check failed:', err)
      }
    })

    return () => {
      generationRef.current++
    }
  }, [token])

  const subscribe = async (): Promise<boolean> => {
    if (!supported || !token) return false
    setError(null)
    const isStale = claimGeneration(generationRef)
    const activeToken: string = token

    return queueRef.current.enqueue(() =>
      runSubscribeOp({
        isStale,
        ready: () => navigator.serviceWorker.ready.then((reg) => reg.pushManager),
        requestPermission: () => Notification.requestPermission(),
        getVapidPublicKey: async () => (await api.getVapidPublicKey()).publicKey,
        upload: (sub) => api.subscribePush(sub, activeToken),
        setPermission,
        setSubscribed,
        setError,
      }),
    )
  }

  const unsubscribe = async (): Promise<void> => {
    if (!supported || !token) return
    setError(null)
    const isStale = claimGeneration(generationRef)
    const activeToken: string = token

    return queueRef.current.enqueue(() =>
      runUnsubscribeOp({
        isStale,
        ready: () => navigator.serviceWorker.ready.then((reg) => reg.pushManager),
        deleteEndpoint: (endpoint) => api.unsubscribePush(endpoint, activeToken),
        setSubscribed,
        setError,
      }),
    )
  }

  return { supported, subscribed, permission, error, subscribe, unsubscribe }
}
