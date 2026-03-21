import { useState, useEffect } from 'preact/hooks'
import { Keypair, loadKeypair, generateKeypair, saveKeypair, clearKeypair, signEIP191, deriveKeypair } from '../lib/burner'
import { api } from '../lib/api'
import { getToken, clearToken } from '../lib/session'

export function useIdentity() {
  const [identity, setIdentity] = useState<Keypair | null>(null)
  const [isRegistered, setIsRegistered] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  function tryImportFromHash(): boolean {
    const hash = window.location.hash.replace('#', '')
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return false
    try {
      const imported = deriveKeypair(hash)
      saveKeypair(imported)
      history.replaceState(null, '', window.location.pathname)
      setIdentity(imported)
      setError(null)
      checkRegistration(imported.address)
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to import key from URL'
      setError(msg)
      console.error('Key import failed:', err)
      return false
    }
  }

  useEffect(() => {
    if (tryImportFromHash()) return

    // Normal flow: load existing or generate new
    const loaded = loadKeypair()
    if (loaded) {
      setIdentity(loaded)
      checkRegistration(loaded.address)
    } else {
      const generated = generateKeypair()
      saveKeypair(generated)
      setIdentity(generated)
      checkRegistration(generated.address)
    }

    const handleHashChange = () => { tryImportFromHash() }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  async function checkRegistration(address: string) {
    try {
      const { pubkey } = await api.getPubkey(address)
      setIsRegistered(!!pubkey)
    } catch (err) {
      console.error('Failed to check registration:', err)
    } finally {
      setLoading(false)
    }
  }

  async function register() {
    if (!identity) return
    setLoading(true)
    try {
      const { challenge, nonce } = await api.getRegChallenge(identity.address)
      const sig = await signEIP191(challenge, identity.privateKey)
      await api.register(identity.address, identity.publicKey, sig, nonce)
      setIsRegistered(true)
    } catch (err) {
      console.error('Registration failed:', err)
      throw err
    } finally {
      setLoading(false)
    }
  }

  async function logout() {
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
      checkRegistration(generated.address)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save new key'
      setError(msg)
      console.error('Failed to save new keypair:', err)
    }
  }

  function importIdentity(keypair: Keypair) {
    saveKeypair(keypair)
    setIdentity(keypair)
    checkRegistration(keypair.address)
  }

  return { identity, isRegistered, loading, error, register, logout, importIdentity }
}
