import * as secp from '@noble/secp256k1'
import { keccak256, hexToBytes, bytesToHex, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ensure0x } from './hex'

export interface Keypair {
  privateKey: string
  publicKey: string
  address: string
}

export function generateKeypair(): Keypair {
  const privKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  return deriveKeypair(privKey)
}

export function deriveKeypair(privKey: string): Keypair {
  const privBytes = hexToBytes(ensure0x(privKey))
  const pubBytes = secp.getPublicKey(privBytes, true) // compressed
  const publicKey = bytesToHex(pubBytes)
  
  // Ethereum address from public key:
  // 1. Get uncompressed pubkey (65 bytes, starts with 0x04)
  // 2. Remove 0x04 prefix (64 bytes)
  // 3. keccak256(remaining 64 bytes)
  // 4. Take last 20 bytes
  const uncompressedPub = secp.getPublicKey(privBytes, false)
  const hash = keccak256(uncompressedPub.slice(1))
  const address = getAddress(`0x${hash.slice(-40)}`)
  
  return { privateKey: privKey, publicKey, address }
}

export async function signEIP191(message: string, privateKey: string): Promise<string> {
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  return await account.signMessage({ message })
}

const STORAGE_KEY = 'eth_chat_burner_v1'

export function saveKeypair(keypair: Keypair) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keypair))
}

export function loadKeypair(): Keypair | null {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return null
  try {
    return JSON.parse(stored)
  } catch {
    return null
  }
}

export function clearKeypair() {
  localStorage.removeItem(STORAGE_KEY)
}

export function saveBackup(kp: Keypair): void {
  localStorage.setItem(`eth_chat_burner_backup_${Date.now()}`, JSON.stringify(kp))
}

export function loadBackups(): Array<{ ts: number; keypair: Keypair }> {
  return Object.keys(localStorage)
    .filter(k => k.startsWith('eth_chat_burner_backup_'))
    .map(k => ({ ts: parseInt(k.split('_').at(-1)!), keypair: JSON.parse(localStorage.getItem(k)!) }))
    .sort((a, b) => b.ts - a.ts)
}

export function deleteBackup(ts: number): void {
  localStorage.removeItem(`eth_chat_burner_backup_${ts}`)
}
