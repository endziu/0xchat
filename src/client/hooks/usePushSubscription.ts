import { useEffect, useState } from 'preact/hooks'
import { api } from '../lib/api'

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
export function usePushSubscription(token: string | null) {
  const [supported, setSupported] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [permission, setPermission] = useState<NotificationPermission | null>(
    typeof Notification === 'undefined' ? null : Notification.permission,
  )

  useEffect(() => {
    const isSupported = 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined'
    setSupported(isSupported)
    if (!isSupported || !token) return

    let mounted = true
    ;(async () => {
      try {
        const reg = await navigator.serviceWorker.ready
        const existing = await reg.pushManager.getSubscription()
        if (existing) {
          // A browser subscription alone is not enough: the server may have
          // rejected or lost it. Re-upload it whenever a session starts.
          await api.subscribePush(existing.toJSON() as PushSubscriptionJSON)
        }
        if (mounted) {
          setSubscribed(!!existing)
          setError(null)
        }
      } catch (err) {
        if (mounted) {
          setSubscribed(false)
          setError('Could not connect notifications. Try enabling them again.')
        }
        console.error('Push subscription check failed:', err)
      }
    })()

    return () => {
      mounted = false
    }
  }, [token])

  const subscribe = async (): Promise<boolean> => {
    if (!supported || !token) return false
    setError(null)
    try {
      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== 'granted') {
        setError('Notification permission was not granted.')
        return false
      }

      const reg = await navigator.serviceWorker.ready
      const { publicKey } = await api.getVapidPublicKey()
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
      await api.subscribePush(sub.toJSON() as PushSubscriptionJSON)
      setSubscribed(true)
      return true
    } catch (err) {
      setError('Could not enable notifications. Please try again.')
      console.error('Push subscribe failed:', err)
      return false
    }
  }

  const unsubscribe = async (): Promise<void> => {
    if (!supported) return
    setError(null)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await api.unsubscribePush(sub.endpoint).catch(() => {})
        await sub.unsubscribe()
      }
      setSubscribed(false)
    } catch (err) {
      setError('Could not disable notifications. Please try again.')
      console.error('Push unsubscribe failed:', err)
    }
  }

  return { supported, subscribed, permission, error, subscribe, unsubscribe }
}
