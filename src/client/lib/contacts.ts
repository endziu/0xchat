import { parseAddress, type Address } from '../../shared/address'
import { migrateKey } from './storage-migration'

const STORAGE_KEY = '0xchat_known_contacts_v1'
const OLD_STORAGE_KEY = 'eth_chat_known_contacts_v1'
// Removed conversations; the key keeps its old name so existing removals survive.
const DELETED_KEY = '0xchat_deleted_contacts_v1'
const OLD_DELETED_KEY = 'eth_chat_deleted_contacts_v1'

export interface KnownContact {
  address: Address
  last_message_at: number
}

export function getLastSeenKey(address: Address): string {
  const canonicalKey = `last_seen_${address}`
  // Old clients could persist metadata under the casing of a shared link.
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
  for (const key of keys) {
    if (!key || key === canonicalKey || !key.startsWith('last_seen_')
      || parseAddress(key.slice('last_seen_'.length)) !== address) continue
    const latest = Math.max(Number(localStorage.getItem(canonicalKey)) || 0, Number(localStorage.getItem(key)) || 0)
    localStorage.setItem(canonicalKey, String(latest))
    localStorage.removeItem(key)
  }
  return canonicalKey
}

const lastSeenListeners = new Set<() => void>()

/**
 * Records that a conversation has been read through the message accepted at
 * `createdAt`. Only moves forward; listeners hear about each advance.
 */
export function markConversationSeen(address: Address, createdAt: number): void {
  const key = getLastSeenKey(address)
  if (Number(localStorage.getItem(key)) >= createdAt) return
  localStorage.setItem(key, String(createdAt))
  for (const listener of lastSeenListeners) listener()
}

export function subscribeLastSeen(listener: () => void): () => void {
  lastSeenListeners.add(listener)
  return () => { lastSeenListeners.delete(listener) }
}

function loadRemoved(): Record<Address, number> {
  migrateKey(OLD_DELETED_KEY, DELETED_KEY)
  try {
    const removed: Record<Address, number> = {}
    for (const [key, value] of Object.entries(JSON.parse(localStorage.getItem(DELETED_KEY) ?? '{}'))) {
      const address = parseAddress(key)
      if (address && typeof value === 'number' && Number.isFinite(value)) {
        removed[address] = Math.max(removed[address] ?? 0, value)
      }
    }
    saveRemoved(removed)
    return removed
  } catch {
    return {}
  }
}

function saveRemoved(removed: Record<Address, number>) {
  localStorage.removeItem(OLD_DELETED_KEY)
  localStorage.setItem(DELETED_KEY, JSON.stringify(removed))
}

// Removes a conversation from the list, forgetting what is stored for it. It
// stays removed until new activity (a later last_message_at) supersedes that.
export function markConversationRemoved(address: Address) {
  const key = address

  const contacts = loadContacts()
  delete contacts[key]
  saveContacts(contacts)

  const removed = loadRemoved()
  removed[key] = Date.now()
  saveRemoved(removed)

  localStorage.removeItem(getLastSeenKey(key))
}

export function isRemoved(address: Address, lastMessageAt: number): boolean {
  const removedAt = loadRemoved()[address]
  return removedAt !== undefined && lastMessageAt <= removedAt
}

export function loadContacts(): Record<Address, KnownContact> {
  migrateKey(OLD_STORAGE_KEY, STORAGE_KEY)
  try {
    const contacts: Record<Address, KnownContact> = {}
    for (const [key, value] of Object.entries(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))) {
      const address = parseAddress(key)
      if (!address || !value || typeof value !== 'object' || !('address' in value)
        || parseAddress(value.address) !== address || !('last_message_at' in value)
        || typeof value.last_message_at !== 'number' || !Number.isFinite(value.last_message_at)) continue
      if (!contacts[address] || value.last_message_at > contacts[address].last_message_at) {
        contacts[address] = { address, last_message_at: value.last_message_at }
      }
    }
    saveContacts(contacts)
    return contacts
  } catch {
    return {}
  }
}

export function saveContacts(contacts: Record<Address, KnownContact>) {
  localStorage.removeItem(OLD_STORAGE_KEY)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts))
}

export function mergeContacts(seen: KnownContact[]): Record<Address, KnownContact> {
  const current = loadContacts()
  for (const { address, last_message_at } of seen) {
    const key = address
    const existing = current[key]
    if (!existing || last_message_at > existing.last_message_at) {
      current[key] = { address, last_message_at }
    }
  }
  saveContacts(current)
  return current
}

/** Normalize legacy label keys; an existing canonical label wins a collision. */
export function loadLabels(): Record<Address, string> {
  try {
    const labels: Record<Address, string> = {}
    const entries = Object.entries(JSON.parse(localStorage.getItem('conversation_labels') ?? '{}'))
    for (const [key, value] of entries) {
      const address = parseAddress(key)
      if (address && typeof value === 'string' && value && (!labels[address] || key === address)) labels[address] = value
    }
    localStorage.setItem('conversation_labels', JSON.stringify(labels))
    return labels
  } catch {
    return {}
  }
}
