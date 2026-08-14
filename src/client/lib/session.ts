const SESSION_KEY = 'eth_chat_session_v1'
const LEGACY_TOKEN_KEY = 'eth_chat_token'

interface StoredSession {
  address: string
  token: string
}

let activeAddress: string | null = null

export function setActiveSessionAddress(address: string | null): void {
  activeAddress = address?.toLowerCase() ?? null
}

export function saveToken(address: string, token: string): void {
  activeAddress = address.toLowerCase()
  localStorage.removeItem(LEGACY_TOKEN_KEY)
  localStorage.setItem(SESSION_KEY, JSON.stringify({ address: activeAddress, token }))
}

export function getToken(address = activeAddress): string | null {
  localStorage.removeItem(LEGACY_TOKEN_KEY)
  if (!address) return null

  const raw = localStorage.getItem(SESSION_KEY)
  if (!raw) return null

  try {
    const session = JSON.parse(raw) as Partial<StoredSession>
    if (
      typeof session.address !== 'string'
      || typeof session.token !== 'string'
      || session.address.toLowerCase() !== address.toLowerCase()
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
