import { useState, useEffect } from 'preact/hooks'
import { Keypair, loadKeypair, generateKeypair, saveKeypair, clearKeypair, signEIP191, deriveKeypair } from '../lib/burner'
import { api } from '../lib/api'
import { getToken, clearToken } from '../lib/session'

export function useIdentity() {
  const [identity, setIdentity] = useState<Keypair | null>(null)
  const [isRegistered, setIsRegistered] = useState(false)
  const [loading, setLoading] = useState(true)

  function tryImportFromHash(): boolean {
    const hash = window.location.hash.replace('#', '')
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return false
    const imported = deriveKeypair(hash)
    saveKeypair(imported)
    history.replaceState(null, '', window.location.pathname)
    setIdentity(imported)
    checkRegistration(imported.address)
    return true
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
    const current = loadKeypair()
    const token = getToken()

    // Only try to delete if we have a valid token
    if (current && token) {
      try {
        await api.deleteAddress(current.address)
      } catch (err) {
        console.error('Failed to delete address:', err)
      }
    }

    clearKeypair()
    clearToken()
    setIdentity(null)
    setIsRegistered(false)

    const generated = generateKeypair()
    saveKeypair(generated)
    setIdentity(generated)
    checkRegistration(generated.address)
  }

  function importIdentity(keypair: Keypair) {
    saveKeypair(keypair)
    setIdentity(keypair)
    checkRegistration(keypair.address)
  }

  return { identity, isRegistered, loading, register, logout, importIdentity }
}
