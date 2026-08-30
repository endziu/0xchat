import { useEffect, useState, useRef } from 'preact/hooks'
import { api } from '../lib/api'
import { reuploadExistingSubscription } from '../lib/push-reupload'
import { requestPushPermission } from '../lib/push-permission'
import { createSerialQueue } from '../lib/push-queue'

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

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
    const generation = ++generationRef.current
    const isStale = () => generation !== generationRef.current

    queueRef.current.enqueue(async () => {
      try {
        const reg = await navigator.serviceWorker.ready
        if (isStale()) return
        const result = await reuploadExistingSubscription({
          getSubscription: () => reg.pushManager.getSubscription(),
          upload: (sub) => api.subscribePush(sub, activeToken),
          isStale,
        })
        if (result.handled) {
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
    const generation = ++generationRef.current
    const isStale = () => generation !== generationRef.current

    return queueRef.current.enqueue(async () => {
      try {
        const perm = await requestPushPermission({
          requestPermission: () => Notification.requestPermission(),
          isStale,
        })
        if (perm.superseded) return false
        setPermission(perm.permission)
        if (!perm.granted) {
          setError('Notification permission was not granted.')
          return false
        }

        const reg = await navigator.serviceWorker.ready
        const { publicKey } = await api.getVapidPublicKey()
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        })
        if (isStale()) return false

        await api.subscribePush(sub.toJSON() as PushSubscriptionJSON, token)
        if (isStale()) return false

        setSubscribed(true)
        return true
      } catch (err) {
        if (!isStale()) setError('Could not enable notifications. Please try again.')
        console.error('Push subscribe failed:', err)
        return false
      }
    })
  }

  const unsubscribe = async (): Promise<void> => {
    if (!supported || !token) return
    setError(null)
    const generation = ++generationRef.current
    const isStale = () => generation !== generationRef.current

    return queueRef.current.enqueue(async () => {
      try {
        const reg = await navigator.serviceWorker.ready
        if (isStale()) return
        const sub = await reg.pushManager.getSubscription()
        if (sub) {
          if (isStale()) return
          await api.unsubscribePush(sub.endpoint, token).catch(() => {})
          if (isStale()) return
          await sub.unsubscribe()
        }
        if (isStale()) return
        setSubscribed(false)
      } catch (err) {
        if (!isStale()) setError('Could not disable notifications. Please try again.')
        console.error('Push unsubscribe failed:', err)
      }
    })
  }

  return { supported, subscribed, permission, error, subscribe, unsubscribe }
}
