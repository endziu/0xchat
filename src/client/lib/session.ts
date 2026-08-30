const SESSION_KEY = 'eth_chat_session_v1'
const LEGACY_TOKEN_KEY = 'eth_chat_token'

interface StoredSession {
  address: string
  token: string
}

export function saveToken(address: string, token: string): void {
  const normalized = address.toLowerCase()
  localStorage.removeItem(LEGACY_TOKEN_KEY)
  localStorage.setItem(SESSION_KEY, JSON.stringify({ address: normalized, token }))
}

export function getToken(address: string): string | null {
  localStorage.removeItem(LEGACY_TOKEN_KEY)
  const normalized = address.toLowerCase()

  const raw = localStorage.getItem(SESSION_KEY)
  if (!raw) return null

  try {
    const session = JSON.parse(raw) as Partial<StoredSession>
    if (
      typeof session.address !== 'string'
      || typeof session.token !== 'string'
      || session.address.toLowerCase() !== normalized
    ) {
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
  localStorage.removeItem(LEGACY_TOKEN_KEY)
}
