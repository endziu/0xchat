const STORAGE_KEY = 'eth_chat_known_contacts_v1'
const DELETED_KEY = 'eth_chat_deleted_contacts_v1'

export interface KnownContact {
  address: string
  last_message_at: number
}

export const getLastSeenKey = (address: string) => `last_seen_${address.toLowerCase()}`

function loadDeleted(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(DELETED_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function saveDeleted(deleted: Record<string, number>) {
  localStorage.setItem(DELETED_KEY, JSON.stringify(deleted))
}

// Marks a conversation as deleted so it stays hidden until new activity
// (a later last_message_at) supersedes the deletion.
export function deleteContact(address: string) {
  const key = address.toLowerCase()

  const contacts = loadContacts()
  delete contacts[key]
  saveContacts(contacts)

  const deleted = loadDeleted()
  deleted[key] = Date.now()
  saveDeleted(deleted)

  localStorage.removeItem(getLastSeenKey(key))
}

export function isDeleted(address: string, lastMessageAt: number): boolean {
  const deletedAt = loadDeleted()[address.toLowerCase()]
  return deletedAt !== undefined && lastMessageAt <= deletedAt
}

export function loadContacts(): Record<string, KnownContact> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function saveContacts(contacts: Record<string, KnownContact>) {
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
