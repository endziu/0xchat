import { UNSUPPORTED_PUSH_SERVICE_CODE } from '../../shared/api-error'
import { ApiError } from './api'
import { requestPushPermission } from './push-permission'

// Orchestration for the two user-initiated push operations (subscribe,
// unsubscribe). The hook owns the queue, generation claims, and state; these
// functions own the per-op flow and take every side effect as an injected
// dependency so supersession paths are unit-testable without a browser.
//
// Contract: once the op has committed to browser state — a subscription was
// created (subscribe) or looked up (unsubscribe) — browser-side cleanup always
// completes, even if the op is superseded mid-flight. Only server writes and
// UI state updates are gated on the generation: a stale op finishing local
// cleanup is harmless, but skipping it leaks a browser subscription the
// server no longer knows about (or that the next identity would silently
// re-upload under a different token).

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

// Minimal push-manager surface the ops need (keeps fakes light in tests; the
// real PushManager is structurally assignable).
export interface PushManagerLike {
  subscribe(options: PushSubscriptionOptionsInit): Promise<PushSubscription>
  getSubscription(): Promise<PushSubscription | null>
}

export interface SubscribeOpDeps {
  isStale: () => boolean
  ready: () => Promise<PushManagerLike>
  requestPermission: () => Promise<NotificationPermission>
  getVapidPublicKey: () => Promise<string>
  upload: (sub: PushSubscriptionJSON) => Promise<unknown>
  setPermission: (permission: NotificationPermission) => void
  setSubscribed: (subscribed: boolean) => void
  setError: (message: string) => void
}

export async function runSubscribeOp(deps: SubscribeOpDeps): Promise<boolean> {
  try {
    const perm = await requestPushPermission({ requestPermission: deps.requestPermission, isStale: deps.isStale })
    if (perm.superseded) return false
    if (perm.permission === null) return false // defensive: not superseded implies we prompted
    deps.setPermission(perm.permission)
    if (!perm.granted) {
      deps.setError('Notification permission was not granted.')
      return false
    }

    const push = await deps.ready()
    if (deps.isStale()) return false
    const publicKey = await deps.getVapidPublicKey()
    if (deps.isStale()) return false
    const sub = await push.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
    // From here the browser subscription exists. Every supersession path from
    // this point down must remove it — it was never uploaded (or is no longer
    // ours), and leaving it lets the next identity's re-upload push it under a
    // different token.
    if (deps.isStale()) {
      await sub.unsubscribe().catch(() => {})
      return false
    }

    await deps.upload(sub.toJSON() as PushSubscriptionJSON)
    if (deps.isStale()) {
      await sub.unsubscribe().catch(() => {})
      return false
    }

    deps.setSubscribed(true)
    return true
  } catch (err) {
    if (!deps.isStale()) {
      deps.setError(
        err instanceof ApiError && err.code === UNSUPPORTED_PUSH_SERVICE_CODE
          ? "This browser's push service is not supported. Try an official Chrome, Firefox, Safari, or Edge build."
          : 'Could not enable notifications. Please try again.',
      )
    }
    console.error('Push subscribe failed:', err)
    return false
  }
}

export interface UnsubscribeOpDeps {
  isStale: () => boolean
  ready: () => Promise<PushManagerLike>
  deleteEndpoint: (endpoint: string) => Promise<unknown>
  setSubscribed: (subscribed: boolean) => void
  setError: (message: string) => void
}

export async function runUnsubscribeOp(deps: UnsubscribeOpDeps): Promise<void> {
  try {
    const push = await deps.ready()
    const sub = await push.getSubscription()
    if (sub) {
      // Server write only while current (a newer identity already owns the
      // endpoint); local cleanup always completes — a stale op returning early
      // here would leave a browser sub the server no longer knows about.
      if (!deps.isStale()) await deps.deleteEndpoint(sub.endpoint).catch(() => {})
      await sub.unsubscribe()
    }
    if (!deps.isStale()) deps.setSubscribed(false)
  } catch (err) {
    if (!deps.isStale()) deps.setError('Could not disable notifications. Please try again.')
    console.error('Push unsubscribe failed:', err)
  }
}
