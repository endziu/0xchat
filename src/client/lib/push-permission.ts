// Ask for the browser push-notification permission, guarding against a
// superseded caller. A subscribe operation can be overtaken by a newer
// generation (identity switch / another op) while it waits in the queue; in
// that case we must neither prompt the user nor touch UI state (a late denial
// would otherwise overwrite the current error).
export interface PermissionResult {
  // True when this call was superseded before or during the prompt. Callers
  // must leave all state alone and drop the operation.
  superseded: boolean
  // Whether permission was granted (only meaningful when not superseded).
  granted: boolean
  // The permission value, or null when we never prompted.
  permission: NotificationPermission | null
}

export async function requestPushPermission(args: {
  requestPermission: () => Promise<NotificationPermission>
  isStale: () => boolean
}): Promise<PermissionResult> {
  if (args.isStale()) return { superseded: true, granted: false, permission: null }

  const permission = await args.requestPermission()

  if (args.isStale()) return { superseded: true, granted: false, permission }
  return { superseded: false, granted: permission === 'granted', permission }
}
