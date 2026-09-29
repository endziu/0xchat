import { migrateKey } from './storage-migration'

const STORAGE_KEY = '0xchat_known_contacts_v1'
const OLD_STORAGE_KEY = 'eth_chat_known_contacts_v1'
// Removed conversations; the key keeps its old name so existing removals survive.
const DELETED_KEY = '0xchat_deleted_contacts_v1'
const OLD_DELETED_KEY = 'eth_chat_deleted_contacts_v1'

export interface KnownContact {
  address: string
  last_message_at: number
}

export const getLastSeenKey = (address: string) => `last_seen_${address.toLowerCase()}`

const lastSeenListeners = new Set<() => void>()

/**
 * Records that a conversation has been read through the message accepted at
 * `createdAt`. Only moves forward; listeners hear about each advance.
 */
export function markConversationSeen(address: string, createdAt: number): void {
  const key = getLastSeenKey(address)
  if (Number(localStorage.getItem(key)) >= createdAt) return
  localStorage.setItem(key, String(createdAt))
  for (const listener of lastSeenListeners) listener()
}

export function subscribeLastSeen(listener: () => void): () => void {
  lastSeenListeners.add(listener)
  return () => { lastSeenListeners.delete(listener) }
}

function loadRemoved(): Record<string, number> {
  migrateKey(OLD_DELETED_KEY, DELETED_KEY)
  try {
    return JSON.parse(localStorage.getItem(DELETED_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function saveRemoved(removed: Record<string, number>) {
  localStorage.removeItem(OLD_DELETED_KEY)
  localStorage.setItem(DELETED_KEY, JSON.stringify(removed))
}

// Removes a conversation from the list, forgetting what is stored for it. It
// stays removed until new activity (a later last_message_at) supersedes that.
export function markConversationRemoved(address: string) {
  const key = address.toLowerCase()

  const contacts = loadContacts()
  delete contacts[key]
  saveContacts(contacts)

  const removed = loadRemoved()
  removed[key] = Date.now()
  saveRemoved(removed)

  localStorage.removeItem(getLastSeenKey(key))
}

export function isRemoved(address: string, lastMessageAt: number): boolean {
  const removedAt = loadRemoved()[address.toLowerCase()]
  return removedAt !== undefined && lastMessageAt <= removedAt
}

export function loadContacts(): Record<string, KnownContact> {
  migrateKey(OLD_STORAGE_KEY, STORAGE_KEY)
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function saveContacts(contacts: Record<string, KnownContact>) {
  localStorage.removeItem(OLD_STORAGE_KEY)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts))
}

export function mergeContacts(seen: KnownContact[]): Record<string, KnownContact> {
  const current = loadContacts()
  for (const { address, last_message_at } of seen) {
    const key = address.toLowerCase()
    const existing = current[key]
    if (!existing || last_message_at > existing.last_message_at) {
      current[key] = { address, last_message_at }
    }
  }
  saveContacts(current)
  return current
}
