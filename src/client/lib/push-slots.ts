import { api } from './api'
import type { PushSlotCondition, PushSlotHandle } from '../../shared/push-slot'

interface Preference {
  enabled: boolean
  handle?: PushSlotHandle
}

// Installation IDs and handles are not credentials. Session tokens and endpoints
// are deliberately not persisted here. Each identity has its own off/enable choice.
function preferenceKey(address: string): string { return `0xchat.push.${address.toLowerCase()}` }
function preference(address: string): Preference {
  const stored = localStorage.getItem(preferenceKey(address))
  if (!stored) return { enabled: false }
  try { return JSON.parse(stored) as Preference } catch { return { enabled: false } }
}
function save(address: string, value: Preference): void {
  localStorage.setItem(preferenceKey(address), JSON.stringify(value))
}
function installationId(): string {
  const key = '0xchat.push.installation'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const id = crypto.randomUUID()
  localStorage.setItem(key, id)
  return id
}
function condition(installation: string, handle?: PushSlotHandle): PushSlotCondition {
  return { installation_id: installation, expected_revision: handle?.revision ?? 0,
    ...(handle ? { slot_id: handle.slot_id } : {}) }
}

export function rememberPushDisabled(address: string): void {
  save(address, { ...preference(address), enabled: false })
}

/** Read-only server confirmation. Never upload, adopt legacy bindings, or repair on a visit. */
export async function checkPushSlot(address: string, token: string): Promise<boolean> {
  const installation = installationId()
  const listed = await api.listPushSlots(token)
  const current = preference(address)
  const slot = listed.slots.find(slot => slot.installation_id === installation)
  const revoked = listed.revocations.find(slot => slot.installation_id === installation)
  if (revoked) save(address, { enabled: false, handle: revoked })
  return !!(current.enabled && slot?.state === 'active')
}

/** Called only by an explicit enable gesture. Refresh once; never retry a stale write. */
export async function enablePushSlot(address: string, token: string, subscription: PushSubscriptionJSON,
  isStale: () => boolean): Promise<void> {
  const installation = installationId()
  const listed = await api.listPushSlots(token)
  if (isStale()) return
  const current = [...listed.slots, ...listed.revocations].find(slot => slot.installation_id === installation)
  const handle = await api.subscribePush(subscription, condition(installation, current), token)
  // Keep the accepted handle for cleanup even if the UI generation was superseded.
  save(address, { enabled: !isStale(), handle })
}

/** Removal is independent of the browser subscription surviving locally. */
export async function removePushSlot(address: string, token: string, isStale: () => boolean): Promise<void> {
  const installation = installationId()
  const listed = await api.listPushSlots(token)
  if (isStale()) return
  const current = [...listed.slots, ...listed.revocations].find(slot => slot.installation_id === installation)
  if (!current) return
  const handle = await api.unsubscribePush(condition(installation, current), token)
  save(address, { enabled: false, handle })
}
