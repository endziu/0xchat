import { useState, useEffect, useCallback } from 'preact/hooks'
import { Keypair, loadKeypair, generateKeypair, saveKeypair, clearKeypair, signEIP191 } from '../lib/burner'
import { api } from '../lib/api'
import { getToken, clearToken } from '../lib/session'

export function useIdentity() {
  const [identity, setIdentity] = useState<Keypair | null>(null)
  const [isRegistered, setIsRegistered] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const isAddressRegistered = useCallback(async (address: string): Promise<boolean> => {
    const { pubkey } = await api.getPubkey(address)
    return !!pubkey
  }, [])

  const registerIdentity = useCallback(async (keypair: Keypair): Promise<void> => {
    const { challenge, nonce } = await api.getRegChallenge(keypair.address, keypair.publicKey)
    const signature = await signEIP191(challenge, keypair.privateKey)
    await api.register(keypair.address, keypair.publicKey, signature, nonce)
  }, [])

  const prepareIdentity = useCallback(async (keypair: Keypair): Promise<void> => {
    if (!await isAddressRegistered(keypair.address)) {
      await registerIdentity(keypair)
    }
  }, [isAddressRegistered, registerIdentity])

  const commitIdentity = useCallback((keypair: Keypair): void => {
    saveKeypair(keypair)
    setIdentity(keypair)
    setIsRegistered(true)
    setError(null)
  }, [])

  useEffect(() => {
    async function init() {
      setLoading(true)
      try {
        const loaded = loadKeypair()
        const keypair = loaded ?? generateKeypair()
        if (!loaded) saveKeypair(keypair)

        setIdentity(keypair)
        setError(null)
        await prepareIdentity(keypair)
        setIsRegistered(true)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Initialization failed'
        setError(message)
        setIsRegistered(false)
        console.error('Identity init failed:', err)
      } finally {
        setLoading(false)
      }
    }

    init()
  }, [prepareIdentity])

  const logout = useCallback(async () => {
    const token = identity ? getToken(identity.address) : null
    let deleteError: string | null = null

    if (identity && token) {
      try {
        await api.deleteAddress(identity.address, token)
      } catch (err) {
        deleteError = err instanceof Error ? err.message : 'Failed to notify server'
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
      await prepareIdentity(generated)
      setIsRegistered(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save new key'
      setError(message)
      console.error('Failed to save new keypair:', err)
    }
  }, [identity, prepareIdentity])

  return {
    identity,
    isRegistered,
    loading,
    error,
    logout,
    prepareIdentity,
    commitIdentity,
  }
}
