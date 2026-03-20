import { useState, useEffect } from 'preact/hooks'
import { getToken, saveToken, clearToken } from '../lib/session'
import { Keypair, signEIP191 } from '../lib/burner'
import { api } from '../lib/api'

export function useSession(identity: Keypair | null) {
  const [token, setToken] = useState<string | null>(getToken())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function login() {
    if (!identity) return
    setLoading(true)
    setError(null)
    try {
      const { challenge, nonce } = await api.getChallenge(identity.address)
      const signature = await signEIP191(challenge, identity.privateKey)
      const { token: newToken } = await api.createSession(identity.address, signature, nonce)
      saveToken(newToken)
      setToken(newToken)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed'
      console.error('Login failed:', err)
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  function logout() {
    clearToken()
    setToken(null)
    setError(null)
  }

  return { token, loading, error, login, logout }
}
