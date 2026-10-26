import { deriveKeypair, type Keypair } from '../../shared/keypair'

const STORAGE_KEY = 'hushhash_burner_v1'

export function saveKeypair(keypair: Keypair) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keypair))
}

export function loadKeypair(): Keypair | null {
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
}
