import { isCanonicalAddress, type Address } from '../../shared/address'

const STORAGE_KEY = 'hushhash_known_contacts_v1'
const DELETED_KEY = 'hushhash_deleted_contacts_v1'
const LABELS_KEY = 'conversation_labels'

export interface KnownContact {
  address: Address
  last_message_at: number
}

export const getLastSeenKey = (address: Address) => `last_seen_${address}`

// These records are always written keyed by Address; anything else is dropped.
function loadAddressRecord<T>(key: string, valid: (value: unknown) => value is T): Record<Address, T> {
  try {
    const record: Record<Address, T> = {}
    for (const [address, value] of Object.entries(JSON.parse(localStorage.getItem(key) ?? '{}'))) {
      if (isCanonicalAddress(address) && valid(value)) record[address] = value
    }
    return record
  } catch {
    return {}
  }
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
  return loadAddressRecord(DELETED_KEY, (value): value is number => typeof value === 'number')
}

function saveRemoved(removed: Record<Address, number>) {
  localStorage.setItem(DELETED_KEY, JSON.stringify(removed))
}

// Removes a conversation from the list, forgetting what is stored for it. It
// stays removed until new activity (a later last_message_at) supersedes that.
export function markConversationRemoved(address: Address) {
  const contacts = loadContacts()
  delete contacts[address]
  saveContacts(contacts)

  const removed = loadRemoved()
  removed[address] = Date.now()
  saveRemoved(removed)

  localStorage.removeItem(getLastSeenKey(address))
}

export function isRemoved(address: Address, lastMessageAt: number): boolean {
  const removedAt = loadRemoved()[address]
  return removedAt !== undefined && lastMessageAt <= removedAt
}

function isKnownContact(value: unknown): value is KnownContact {
  const contact = value as Partial<KnownContact> | null
  return isCanonicalAddress(contact?.address) && typeof contact.last_message_at === 'number'
}

export function loadContacts(): Record<Address, KnownContact> {
  return loadAddressRecord(STORAGE_KEY, isKnownContact)
}

export function saveContacts(contacts: Record<Address, KnownContact>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts))
}

export function mergeContacts(seen: KnownContact[]): Record<Address, KnownContact> {
  const current = loadContacts()
  for (const { address, last_message_at } of seen) {
    const existing = current[address]
    if (!existing || last_message_at > existing.last_message_at) {
      current[address] = { address, last_message_at }
    }
  }
  saveContacts(current)
  return current
}

export function loadLabels(): Record<Address, string> {
  return loadAddressRecord(LABELS_KEY, (value): value is string => typeof value === 'string')
}

export function saveLabels(labels: Record<Address, string>): void {
  localStorage.setItem(LABELS_KEY, JSON.stringify(labels))
}
