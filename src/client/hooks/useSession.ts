import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { getToken, saveToken, clearToken } from '../lib/session'
import { Keypair, signEIP191 } from '../lib/burner'
import { api } from '../lib/api'

export function useSession(identity: Keypair | null) {
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionEpoch = useRef(0)

  useEffect(() => {
    sessionEpoch.current++
    setToken(identity ? getToken(identity.address) : null)
    setError(null)
  }, [identity?.address])

  const createSession = useCallback(async (keypair: Keypair): Promise<string> => {
    const { challenge, nonce } = await api.getChallenge(keypair.address)
    const signature = await signEIP191(challenge, keypair.privateKey)
    const { token: newToken } = await api.createSession(keypair.address, signature, nonce)
    return newToken
  }, [])

  const commitSession = useCallback((address: string, newToken: string): void => {
    saveToken(address, newToken)
    setToken(newToken)
    setError(null)
  }, [])

  const login = useCallback(async () => {
    if (!identity) return
    const epoch = sessionEpoch.current
    setLoading(true)
    setError(null)
    try {
      const newToken = await createSession(identity)
      if (epoch !== sessionEpoch.current) return
      commitSession(identity.address, newToken)
    } catch (err) {
      if (epoch !== sessionEpoch.current) return
      const message = err instanceof Error ? err.message : 'Login failed'
      console.error('Login failed:', err)
      setError(message)
    } finally {
      if (epoch === sessionEpoch.current) setLoading(false)
    }
  }, [identity, createSession, commitSession])

  const logout = useCallback(() => {
    sessionEpoch.current++
    clearToken()
    setToken(null)
    setError(null)
    setLoading(false)
  }, [])

  return { token, loading, error, login, logout, createSession, commitSession }
}
