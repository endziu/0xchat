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
  const [permission, setPermission] = useState<NotificationPermission | null>(
    typeof Notification !== 'undefined' ? Notification.permission : null,
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
        if (mounted) setSubscribed(!!existing)
      } catch (err) {
        console.error('Push subscription check failed:', err)
      }
    })()

    return () => {
      mounted = false
    }
  }, [token])

  const subscribe = async (): Promise<boolean> => {
    if (!supported || !token) return false
    try {
      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== 'granted') return false

      const reg = await navigator.serviceWorker.ready
      const { publicKey } = await api.getVapidPublicKey()
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
      await api.subscribePush(sub.toJSON() as PushSubscriptionJSON, token)
      setSubscribed(true)
      return true
    } catch (err) {
      console.error('Push subscribe failed:', err)
      return false
    }
  }

  const unsubscribe = async (): Promise<void> => {
    if (!supported || !token) return
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await api.unsubscribePush(sub.endpoint, token).catch(() => {})
        await sub.unsubscribe()
      }
      setSubscribed(false)
    } catch (err) {
      console.error('Push unsubscribe failed:', err)
    }
  }

  return { supported, subscribed, permission, subscribe, unsubscribe }
}
