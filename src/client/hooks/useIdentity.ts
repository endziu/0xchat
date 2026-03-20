import { useState, useEffect } from 'preact/hooks'
import { Keypair, loadKeypair, generateKeypair, saveKeypair, clearKeypair, signEIP191 } from '../lib/burner'
import { api } from '../lib/api'

export function useIdentity() {
  const [identity, setIdentity] = useState<Keypair | null>(null)
  const [isRegistered, setIsRegistered] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
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
      const sig = await signEIP191("ETH-Gate keypair v1", identity.privateKey)
      await api.register(identity.address, identity.publicKey, sig)
      setIsRegistered(true)
    } catch (err) {
      console.error('Registration failed:', err)
      throw err
    } finally {
      setLoading(false)
    }
  }

  function logout() {
    clearKeypair()
    setIdentity(null)
    setIsRegistered(false)
    
    const generated = generateKeypair()
    saveKeypair(generated)
    setIdentity(generated)
    checkRegistration(generated.address)
  }

  function importIdentity(keypair: Keypair) {
    setIdentity(keypair)
    checkRegistration(keypair.address)
  }

  return { identity, isRegistered, loading, register, logout, importIdentity }
}
