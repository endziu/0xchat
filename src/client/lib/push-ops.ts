import { UNSUPPORTED_PUSH_SERVICE_CODE } from '../../shared/api-error'
import { ApiError } from './api'
import { requestPushPermission } from './push-permission'

// Orchestration for the two user-initiated push operations (subscribe,
// unsubscribe). The hook owns the queue, generation claims, and state; these
// functions own the per-op flow and take every side effect as an injected
// dependency so supersession paths are unit-testable without a browser.
//
// Browser cleanup after supersession is conditional on ownership: an older
// tab must not unsubscribe a registration newly enabled by another tab.
//
// One exception outranks that (#84): a superseded subscribe only cleans up
// while it still owns the registration. `releaseIfOwned` re-reads server state
// and answers from the authoritative revision, so late completion cannot
// unsubscribe the endpoint a newer operation has just taken over.

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

// `Written` is whatever the upload hands back to identify what reached the
// server — the op keeps it opaque and only passes it to the release.
export interface SubscribeOpDeps<Written = unknown> {
  isStale: () => boolean
  ready: () => Promise<PushManagerLike>
  requestPermission: () => Promise<NotificationPermission>
  getVapidPublicKey: () => Promise<string>
  upload: (sub: PushSubscriptionJSON) => Promise<Written>
  // Release the server slot this op wrote, if it is still the owned one, and
  // report whether the browser subscription is also this op's to remove.
  releaseIfOwned: (written: Written | undefined) => Promise<boolean>
  mayRemoveBrowser: () => boolean
  setPermission: (permission: NotificationPermission) => void
  setSubscribed: (subscribed: boolean) => void
  setError: (message: string) => void
}

async function abandonSubscribeOp<Written>(deps: SubscribeOpDeps<Written>, sub: PushSubscription,
  written: Written | undefined): Promise<false> {
  const owned = await deps.releaseIfOwned(written).catch(() => false)
  if (owned && deps.mayRemoveBrowser()) await sub.unsubscribe().catch(() => {})
  return false
}

export async function runSubscribeOp<Written>(deps: SubscribeOpDeps<Written>): Promise<boolean> {
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
    // this point down must remove it once it is confirmed still ours — it was
    // never uploaded (or is no longer owned here), and leaving it lets the next
    // identity's re-upload push it under a different token.
    if (deps.isStale()) return await abandonSubscribeOp(deps, sub, undefined)

    const written = await deps.upload(sub.toJSON() as PushSubscriptionJSON)
    if (deps.isStale()) return await abandonSubscribeOp(deps, sub, written)

    deps.setSubscribed(true)
    return true
  } catch (err) {
    if (!deps.isStale()) {
      deps.setError(
        err instanceof ApiError && err.code === UNSUPPORTED_PUSH_SERVICE_CODE
          ? "This browser's push service is not supported. Try an official Chrome, Firefox, Safari, or Edge build."
          : err instanceof ApiError && err.code
            ? err.message
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
  removeSlot: () => Promise<unknown>
  mayRemoveBrowser: () => boolean
  setSubscribed: (subscribed: boolean) => void
  setError: (message: string) => void
}

export async function runUnsubscribeOp(deps: UnsubscribeOpDeps): Promise<void> {
  try {
    const push = await deps.ready()
    const sub = await push.getSubscription()
    let removalFailed = false
    // Even a missing browser subscription can leave an owned server slot.
    if (!deps.isStale()) await deps.removeSlot().catch(() => { removalFailed = true })
    if (sub && deps.mayRemoveBrowser() && !(await sub.unsubscribe())) throw new Error('Browser subscription was not removed')
    if (!deps.isStale()) {
      deps.setSubscribed(false)
      if (removalFailed) deps.setError('Notifications are off here, but server cleanup failed. Old alerts may continue. Retry disabling before enabling another identity.')
    }
  } catch (err) {
    if (!deps.isStale()) deps.setError('Could not disable notifications. Please try again.')
    console.error('Push unsubscribe failed:', err)
  }
}
