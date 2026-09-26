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

// A browser that does not report the key cannot be judged stale by it.
function matchesVapidKey(subscriptionKey: ArrayBuffer | null | undefined, currentKey: Uint8Array): boolean {
  if (!subscriptionKey) return true
  const bytes = new Uint8Array(subscriptionKey)
  return bytes.length === currentKey.length && bytes.every((byte, i) => byte === currentKey[i])
}

async function removeBrowserSubscription(sub: PushSubscription): Promise<void> {
  if (!(await sub.unsubscribe())) throw new Error('Browser subscription was not removed')
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
  // Whether the server marked this browser's slot dead (#90).
  slotNeedsRepair: () => Promise<boolean>
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
    const options = { userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }
    // Only a live, unexpired attempt may drop a subscription to replace it (#86).
    const mayReplace = () => !deps.isStale() && deps.mayRemoveBrowser()

    // A subscription made with another VAPID key makes subscribe() throw, and
    // one behind a slot the server marked dead would just be uploaded again.
    const existing = await push.getSubscription()
    if (deps.isStale()) return false
    const mustReplaceExisting = existing && (!matchesVapidKey(existing.options?.applicationServerKey, options.applicationServerKey)
      || await deps.slotNeedsRepair())
    if (deps.isStale()) return false
    if (mustReplaceExisting) {
      if (!mayReplace()) return false
      await removeBrowserSubscription(existing)
      if (deps.isStale()) return false
    }

    let sub = await push.subscribe(options)
    // From here the browser subscription exists. Every supersession path from
    // this point down must remove it once it is confirmed still ours — it was
    // never uploaded (or is no longer owned here), and leaving it lets the next
    // identity's re-upload push it under a different token.
    if (deps.isStale()) return await abandonSubscribeOp(deps, sub, undefined)

    let written: Written
    try {
      written = await deps.upload(sub.toJSON() as PushSubscriptionJSON)
    } catch (err) {
      // The endpoint is still bound elsewhere, typically to a previous identity
      // whose cleanup failed. Never transfer it: drop it locally, subscribe
      // fresh, and upload once more. The old endpoint dies at the push service.
      if (!(err instanceof ApiError && err.code === 'ownership_conflict') || !mayReplace()) throw err
      await removeBrowserSubscription(sub)
      if (deps.isStale()) return false
      sub = await push.subscribe(options)
      if (deps.isStale()) return await abandonSubscribeOp(deps, sub, undefined)
      written = await deps.upload(sub.toJSON() as PushSubscriptionJSON)
    }
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

// Resolves whether this browser has stopped receiving the identity's alerts:
// either the server slot or the browser subscription is confirmed gone.
export async function runUnsubscribeOp(deps: UnsubscribeOpDeps): Promise<boolean> {
  let serverCleared = false
  try {
    const push = await deps.ready()
    const sub = await push.getSubscription()
    let removalFailed = false
    // Even a missing browser subscription can leave an owned server slot.
    // A removal that went stale may have returned without writing anything.
    if (!deps.isStale()) await deps.removeSlot().then(() => { serverCleared = !deps.isStale() }, () => { removalFailed = true })
    let browserCleared = !sub
    if (sub && deps.mayRemoveBrowser()) {
      await removeBrowserSubscription(sub)
      browserCleared = true
    }
    if (!deps.isStale()) {
      deps.setSubscribed(false)
      if (removalFailed) deps.setError('Notifications are off here, but server cleanup failed. Old alerts may continue. Retry disabling before enabling another identity.')
    }
    return serverCleared || browserCleared
  } catch (err) {
    if (!deps.isStale()) deps.setError('Could not disable notifications. Please try again.')
    console.error('Push unsubscribe failed:', err)
    return serverCleared
  }
}
