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
  // True when this call was superseded; callers must leave state alone.
  superseded: boolean
  // Whether a browser subscription exists (only meaningful when not superseded).
  subscribed: boolean
}

export async function reuploadExistingSubscription(args: {
  getSubscription: () => Promise<PushSubscription | null>
  upload: (sub: PushSubscriptionJSON) => Promise<unknown>
  isStale: () => boolean
}): Promise<ReuploadResult> {
  const existing = await args.getSubscription()
  const supersededAfterRead = args.isStale()

  if (existing && !supersededAfterRead) {
    await args.upload(existing.toJSON() as PushSubscriptionJSON)
  }

  if (supersededAfterRead || args.isStale()) {
    return { superseded: true, subscribed: false }
  }
  return { superseded: false, subscribed: !!existing }
}
