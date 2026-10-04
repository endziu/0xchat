import { parseAddress, type Address } from '../../shared/address'
import { migrateKey } from './storage-migration'

const SESSION_KEY = '0xchat_session_v1'
const OLD_SESSION_KEY = 'eth_chat_session_v1'
const LEGACY_TOKEN_KEY = 'eth_chat_token'

interface StoredSession {
  address: Address
  token: string
}

export function saveToken(address: Address, token: string): void {
  localStorage.removeItem(LEGACY_TOKEN_KEY)
  localStorage.removeItem(OLD_SESSION_KEY)
  localStorage.setItem(SESSION_KEY, JSON.stringify({ address, token }))
}

export function getToken(address: Address): string | null {
  localStorage.removeItem(LEGACY_TOKEN_KEY)
  migrateKey(OLD_SESSION_KEY, SESSION_KEY)

  const raw = localStorage.getItem(SESSION_KEY)
  if (!raw) return null

  try {
    const session = JSON.parse(raw) as Partial<StoredSession>
    if (
      typeof session.address !== 'string'
      || typeof session.token !== 'string'
      || parseAddress(session.address) !== address
    ) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }
    saveToken(address, session.token)
    return session.token
  } catch {
    localStorage.removeItem(SESSION_KEY)
    return null
  }
}

export function clearToken(): void {
  localStorage.removeItem(SESSION_KEY)
  localStorage.removeItem(OLD_SESSION_KEY)
  localStorage.removeItem(LEGACY_TOKEN_KEY)
}

// Clear the stored session only if it still matches the given token. Returns
// true when a matching session was removed. Used on 401 so a stale request
// from a previous identity cannot wipe out a newer committed session.
export function clearTokenIfMatches(token: string): boolean {
  localStorage.removeItem(LEGACY_TOKEN_KEY)
  migrateKey(OLD_SESSION_KEY, SESSION_KEY)
  const raw = localStorage.getItem(SESSION_KEY)
  if (!raw) return false

  try {
    const session = JSON.parse(raw) as Partial<StoredSession>
    if (typeof session.token === 'string' && session.token === token) {
      localStorage.removeItem(SESSION_KEY)
      return true
    }
    return false
  } catch {
    // Corrupt storage cannot match any token, so this is never the current
    // session. Drop it but do NOT report a match — a stale token 401 must not
    // wipe a newer session or fire auth:expired on unparseable data.
    localStorage.removeItem(SESSION_KEY)
    return false
  }
}
