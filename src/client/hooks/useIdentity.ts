import { useState, useEffect } from 'preact/hooks'
import { Keypair, loadKeypair, generateKeypair, saveKeypair, clearKeypair, signEIP191, saveBackup, loadBackups, deleteBackup as deleteBackupFromStorage, deriveKeypair } from '../lib/burner'
import { api } from '../lib/api'

export interface Backup {
  ts: number
  keypair: Keypair
}

export function useIdentity() {
  const [identity, setIdentity] = useState<Keypair | null>(null)
  const [isRegistered, setIsRegistered] = useState(false)
  const [loading, setLoading] = useState(true)
  const [backups, setBackups] = useState<Backup[]>([])

  function tryImportFromHash(): boolean {
    const hash = window.location.hash.replace('#', '')
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return false
    const existing = loadKeypair()
    if (existing) saveBackup(existing)
    const imported = deriveKeypair(hash)
    saveKeypair(imported)
    history.replaceState(null, '', window.location.pathname)
    setIdentity(imported)
    setBackups(loadBackups())
    checkRegistration(imported.address)
    return true
  }

  useEffect(() => {
    if (tryImportFromHash()) return

    // Normal flow
    const loaded = loadKeypair()
    if (loaded) {
      setIdentity(loaded)
      setBackups(loadBackups())
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
    const existing = loadKeypair()
    if (existing && existing.address !== keypair.address) saveBackup(existing)
    saveKeypair(keypair)
    setIdentity(keypair)
    setBackups(loadBackups())
    checkRegistration(keypair.address)
  }

  function switchToBackup(ts: number, kp: Keypair) {
    const existing = loadKeypair()
    if (existing) saveBackup(existing)
    deleteBackupFromStorage(ts)
    saveKeypair(kp)
    setIdentity(kp)
    setBackups(loadBackups())
    checkRegistration(kp.address)
  }

  function deleteBackup(ts: number) {
    deleteBackupFromStorage(ts)
    setBackups(loadBackups())
  }

  return { identity, isRegistered, loading, register, logout, importIdentity, backups, switchToBackup, deleteBackup }
}
