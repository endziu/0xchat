import { api } from './api'
import type { PushSlotCondition, PushSlotHandle, PushSlotList, PushSlotSummary } from '../../shared/push-slot'

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
export async function getPushSlotState(address: string, token: string): Promise<{ enabled: boolean; slots: PushSlotSummary[] }> {
  const installation = installationId()
  const listed: PushSlotList = await api.listPushSlots(token)
  const current = preference(address)
  const slot = listed.slots.find(slot => slot.installation_id === installation)
  const revoked = listed.revocations.find(slot => slot.installation_id === installation)
  if (revoked) save(address, { enabled: false, handle: revoked })
  return { enabled: !!(current.enabled && slot?.state === 'active'), slots: listed.slots }
}

/** Called only by an explicit enable gesture. Refresh once; never retry a stale write. */
export async function enablePushSlot(address: string, token: string, subscription: PushSubscriptionJSON,
  isStale: () => boolean): Promise<PushSlotHandle | undefined> {
  const installation = installationId()
  const listed = await api.listPushSlots(token)
  if (isStale()) return
  const slot = listed.slots.find(slot => slot.installation_id === installation)
  const revocation = listed.revocations.find(slot => slot.installation_id === installation)
  const current = slot ?? revocation
  const handle = slot
    ? await api.reconcilePush(subscription, condition(installation, slot), token)
    : await api.subscribePush(subscription, condition(installation, current), token)
  // The returned handle identifies this write for cleanup. A superseded tab
  // must not overwrite a newer tab's saved preference (or its slot handle).
  if (!isStale()) save(address, { enabled: true, handle })
  return handle
}

/**
 * Cleanup for a superseded operation (#84). It may drop only what it still
 * demonstrably owns: the slot revision it wrote itself, or — when its own
 * write never landed — the browser subscription, and then only while no active
 * slot holds this installation and either a lock is held or no other tab has
 * claimed since. Returns whether the browser subscription is also the caller's to
 * remove, so late completion can never delete a newer registration.
 */
export async function releaseSupersededSlot(address: string, token: string,
  written: PushSlotHandle | undefined, canClean: boolean | (() => boolean)): Promise<boolean> {
  // A newer tab can accept the same browser subscription without advancing the
  // slot revision. Without the origin lock, even a matching revision cannot
  // prove it is still ours if another tab has claimed since. Same-tab changes
  // are ordered by the local queue, so their cleanup remains safe.
  const safe = () => typeof canClean === 'function' ? canClean() : canClean
  if (!safe()) return false
  const installation = installationId()
  const listed = await api.listPushSlots(token)
  if (!safe()) return false
  const active = listed.slots.find(slot => slot.installation_id === installation)
  // Absent server state is usable only while this claim is still safe to clean.
  if (!written) return !active
  if (active?.slot_id !== written.slot_id || active.revision !== written.revision) return false
  const handle = await api.unsubscribePush(condition(installation, written), token)
  save(address, { enabled: false, handle })
  return true
}

/** Removal is independent of the browser subscription surviving locally. */
export async function removePushSlot(address: string, token: string, isStale: () => boolean): Promise<void> {
  const installation = installationId()
  const listed = await api.listPushSlots(token)
  if (isStale()) return
  const current = [...listed.slots, ...listed.revocations].find(slot => slot.installation_id === installation)
  if (!current) return
  const handle = await api.unsubscribePush(condition(installation, current), token)
  // A newer tab may have enabled again while this response was in flight.
  if (!isStale()) save(address, { enabled: false, handle })
}

/** Remote removal deliberately leaves the local browser subscription untouched. */
export async function removeRemotePushSlot(address: string, token: string, slot: PushSlotHandle): Promise<boolean> {
  const removesCurrentInstallation = slot.installation_id === installationId()
  const handle = await api.unsubscribePush(condition(slot.installation_id, slot), token)
  if (removesCurrentInstallation) save(address, { enabled: false, handle })
  return removesCurrentInstallation
}
