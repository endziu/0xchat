import type { Address } from '../../shared/address'

const SESSION_KEY = 'hushhash_session_v1'

interface StoredSession {
  address: Address
  token: string
}

export function saveToken(address: Address, token: string): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ address, token }))
}

export function getToken(address: Address): string | null {
  const raw = localStorage.getItem(SESSION_KEY)
  if (!raw) return null

  try {
    const session = JSON.parse(raw) as Partial<StoredSession>
    if (typeof session.token !== 'string' || session.address !== address) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }
    return session.token
  } catch {
    localStorage.removeItem(SESSION_KEY)
    return null
  }
}

export function clearToken(): void {
  localStorage.removeItem(SESSION_KEY)
}

// Clear the stored session only if it still matches the given token. Returns
// true when a matching session was removed. Used on 401 so a stale request
// from a previous identity cannot wipe out a newer committed session.
export function clearTokenIfMatches(token: string): boolean {
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
