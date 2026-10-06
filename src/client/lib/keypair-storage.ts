import { deriveKeypair, type Keypair } from '../../shared/keypair'
import { migrateKey } from './storage-migration'

const STORAGE_KEY = '0xchat_burner_v1'
const OLD_STORAGE_KEY = 'eth_chat_burner_v1'

export function saveKeypair(keypair: Keypair) {
  localStorage.removeItem(OLD_STORAGE_KEY)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keypair))
}

export function loadKeypair(): Keypair | null {
  migrateKey(OLD_STORAGE_KEY, STORAGE_KEY)
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return null
  try {
    // Derived again rather than read: older identities stored a checksummed address.
    return deriveKeypair(JSON.parse(stored).privateKey)
  } catch {
    return null
  }
}

export function clearKeypair() {
  localStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem(OLD_STORAGE_KEY)
}
