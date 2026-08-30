// Re-upload an existing browser push subscription to the server when a session
// starts. The server may have rejected or lost it, so a browser-only
// subscription is not enough.
//
// This runs asynchronously and can be superseded mid-flight by an identity
// switch or an explicit unsubscribe. Callers supply `isStale`, which must
// return true once a newer operation has started; when it does, we never
// perform the server write (a stale upload would re-create the endpoint
// association under the previous identity).

interface ReuploadResult {
  // True when this call is still the current operation and callers should
  // update their local state. False when superseded: leave state alone.
  handled: boolean
  // Whether a browser subscription exists (only meaningful when handled).
  subscribed: boolean
}

export async function reuploadExistingSubscription(args: {
  getSubscription: () => Promise<PushSubscription | null>
  upload: (sub: PushSubscriptionJSON) => Promise<unknown>
  isStale: () => boolean
}): Promise<ReuploadResult> {
  const existing = await args.getSubscription()
  const currentAfterRead = !args.isStale()

  if (existing && currentAfterRead) {
    await args.upload(existing.toJSON() as PushSubscriptionJSON)
  }

  const handled = currentAfterRead && !args.isStale()
  if (!handled) return { handled: false, subscribed: false }
  return { handled: true, subscribed: !!existing }
}
