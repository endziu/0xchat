import { useState, useEffect, useCallback } from 'preact/hooks'
import { Keypair, loadKeypair, generateKeypair, saveKeypair, clearKeypair, signEIP191 } from '../lib/burner'
import { api } from '../lib/api'
import { getToken, clearToken } from '../lib/session'

export function useIdentity() {
  const [identity, setIdentity] = useState<Keypair | null>(null)
  const [isRegistered, setIsRegistered] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const checkRegistration = useCallback(async (address: string): Promise<boolean> => {
    try {
      const { pubkey } = await api.getPubkey(address)
      const registered = !!pubkey
      setIsRegistered(registered)
      return registered
    } catch (err) {
      console.error('Failed to check registration:', err)
      setIsRegistered(false)
      return false
    }
  }, [])

  const register = useCallback(async (kp?: Keypair) => {
    const key = kp ?? identity
    if (!key) return
    setLoading(true)
    try {
      const { challenge, nonce } = await api.getRegChallenge(key.address)
      const sig = await signEIP191(challenge, key.privateKey)
      await api.register(key.address, key.publicKey, sig, nonce)
      setIsRegistered(true)
    } catch (err) {
      console.error('Registration failed:', err)
      throw err
    } finally {
      setLoading(false)
    }
  }, [identity])

  useEffect(() => {
    async function init() {
      setLoading(true)
      try {
        // Load existing or generate new keypair
        const loaded = loadKeypair()
        const kp = loaded ?? (() => {
          const generated = generateKeypair()
          saveKeypair(generated)
          return generated
        })()

        setIdentity(kp)
        setError(null)

        // Check registration status
        const registered = await checkRegistration(kp.address)

        // Auto-register if not yet registered
        if (!registered) {
          await register(kp)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Initialization failed'
        setError(msg)
        console.error('Identity init failed:', err)
      } finally {
        setLoading(false)
      }
    }

    init()
  }, [])

  const logout = useCallback(async () => {
    const token = getToken()
    let deleteError: string | null = null

    // Only try to delete if we have a valid token
    if (identity && token) {
      try {
        await api.deleteAddress(identity.address)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to notify server'
        deleteError = msg
        console.error('Failed to delete address:', err)
      }
    }

    clearKeypair()
    clearToken()
    setIdentity(null)
    setIsRegistered(false)

    const generated = generateKeypair()
    try {
      saveKeypair(generated)
      setIdentity(generated)
      setError(deleteError ? `Logged out locally. Server cleanup failed: ${deleteError}` : null)
      await checkRegistration(generated.address)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save new key'
      setError(msg)
      console.error('Failed to save new keypair:', err)
    }
  }, [identity, checkRegistration])

  const importIdentity = useCallback(async (keypair: Keypair) => {
    saveKeypair(keypair)
    setIdentity(keypair)
    setError(null)
    const registered = await checkRegistration(keypair.address)
    if (!registered) {
      await register(keypair)
    }
  }, [checkRegistration, register])

  return { identity, isRegistered, loading, error, register, logout, importIdentity }
}
