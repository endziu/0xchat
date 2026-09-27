import { useEffect, useRef, useState } from 'preact/hooks'
import { api, ApiError } from '../lib/api'
import { UNSUPPORTED_PUSH_SERVICE_CODE } from '../../shared/api-error'

// The browser's push subscription is the source of truth; the server mirrors it
// by endpoint. One rule, checked whenever an identity starts: this browser holds
// a subscription only while the current identity has opted in here. A leftover
// from another identity, a failed disable or a rotated VAPID key is removed, and
// an opted-in subscription is uploaded again, so races between tabs or failed
// requests heal on the next load instead of needing coordination.

const TIMEOUT_MS = 30_000
const TIMEOUT_MESSAGE = 'Notifications did not respond within 30 seconds. Check your connection, then reload 0xChat and try again.'

function pushApisAvailable(): boolean {
  return 'serviceWorker' in navigator && typeof window.PushManager !== 'undefined' && typeof Notification !== 'undefined'
}

const optInKey = (address: string) => `0xchat.push.${address.toLowerCase()}`

function isOptedIn(address: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(optInKey(address)) ?? 'null') as { enabled?: unknown } | null)?.enabled === true
  } catch {
    return false
  }
}

// A lost write is harmless: the rule above reconciles it on the next load.
function setOptedIn(address: string, enabled: boolean): void {
  try {
    localStorage.setItem(optInKey(address), JSON.stringify({ enabled }))
  } catch { /* storage blocked */ }
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

// A browser that does not report the key cannot be judged stale by it.
function matchesKey(sub: PushSubscription, key: Uint8Array): boolean {
  const current = sub.options?.applicationServerKey
  if (!current) return true
  const bytes = new Uint8Array(current)
  return bytes.length === key.length && bytes.every((byte, i) => byte === key[i])
}

async function vapidKey(): Promise<Uint8Array<ArrayBuffer>> {
  return urlBase64ToUint8Array((await api.getVapidPublicKey()).publicKey)
}

async function pushManager(): Promise<PushManager> {
  return (await navigator.serviceWorker.ready).pushManager
}

async function removeBrowserSubscription(sub: PushSubscription): Promise<void> {
  if (!(await sub.unsubscribe())) throw new Error('Browser subscription was not removed')
}

function withTimeout<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), TIMEOUT_MS)
  })
  return Promise.race([work(), expired]).finally(() => clearTimeout(timer))
}

/** Apply the rule for this identity; resolves whether notifications are on. */
async function reconcile(address: string, token: string): Promise<boolean> {
  const sub = await (await pushManager()).getSubscription()
  if (!sub) return false
  if (!isOptedIn(address) || !matchesKey(sub, await vapidKey())) {
    await removeBrowserSubscription(sub)
    return false
  }
  await api.subscribePush(sub.toJSON(), token)
  return true
}

function enableErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === UNSUPPORTED_PUSH_SERVICE_CODE) {
    return "This browser's push service is not supported. Try an official Chrome, Firefox, Safari, or Edge build."
  }
  if (err instanceof ApiError && err.code) return err.message
  if (err instanceof Error && err.message === TIMEOUT_MESSAGE) return TIMEOUT_MESSAGE
  return 'Could not enable notifications. Please try again.'
}

export function usePushSubscription(token: string | null, address: string | null) {
  const [supported, setSupported] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [permission, setPermission] = useState<NotificationPermission | null>(
    typeof Notification === 'undefined' ? null : Notification.permission,
  )
  // Orders this tab's operations, so the start-up check cannot remove a
  // subscription an Enable click is creating at the same moment.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const run = <T,>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.current.then(operation)
    queue.current = result.catch(() => undefined)
    return result
  }

  useEffect(() => {
    const isSupported = pushApisAvailable()
    setSupported(isSupported)
    setSubscribed(false)
    setError(null) // an old identity's failure says nothing about this one
    if (!isSupported || !token || !address) return
    let active = true
    void run(async () => {
      try {
        const on = await withTimeout(() => reconcile(address, token))
        if (active) setSubscribed(on)
      } catch (err) {
        console.error('Push reconcile failed:', err)
        if (active) setError('Could not connect notifications. Try enabling them again.')
      }
    })
    return () => { active = false }
  }, [token, address])

  const subscribe = async (): Promise<boolean> => {
    if (!supported || !token || !address) return false
    setError(null)
    // Ask before queueing: the prompt runs straight from the click, and an
    // unanswered one blocks neither the timeout nor a queued identity switch.
    const granted = await Notification.requestPermission()
    setPermission(granted)
    if (granted !== 'granted') {
      setError('Notification permission was not granted.')
      return false
    }
    return run(enable)
  }

  const enable = async (): Promise<boolean> => {
    if (!token || !address) return false
    try {
      await withTimeout(async () => {
        const push = await pushManager()
        const key = await vapidKey()
        const existing = await push.getSubscription()
        // subscribe() rejects while a subscription made with another key exists.
        if (existing && !matchesKey(existing, key)) await removeBrowserSubscription(existing)
        const sub = await push.subscribe({ userVisibleOnly: true, applicationServerKey: key })
        try {
          await api.subscribePush(sub.toJSON(), token)
        } catch (err) {
          // Keep the rule: no browser subscription without a stored opt-in.
          await sub.unsubscribe().catch(() => false)
          throw err
        }
      })
      setOptedIn(address, true)
      setSubscribed(true)
      return true
    } catch (err) {
      console.error('Push subscribe failed:', err)
      setError(enableErrorMessage(err))
      return false
    }
  }

  // Resolves whether this browser has stopped receiving the identity's alerts.
  // Removing the browser subscription is what stops them: the push service then
  // rejects the endpoint and the server drops its row, even if the request
  // below never arrives.
  const unsubscribe = (): Promise<boolean> => run(async () => {
    if (!supported) return true // no browser subscription can exist here
    if (!address) return false
    setOptedIn(address, false)
    setSubscribed(false)
    setError(null)
    try {
      await withTimeout(async () => {
        const sub = await (await pushManager()).getSubscription()
        if (!sub) return
        if (token) await api.unsubscribePush(sub.endpoint, token).catch(() => undefined)
        await removeBrowserSubscription(sub)
      })
      return true
    } catch (err) {
      console.error('Push unsubscribe failed:', err)
      setError('Could not disable notifications. Please try again.')
      return false
    }
  })

  return { supported, subscribed, permission, error, subscribe, unsubscribe }
}
