import * as secp from '@noble/secp256k1'
import { hexToBytes, bytesToHex } from 'viem'
import { ensure0x } from './hex'

export interface EncryptedData {
  ciphertext: string
  ephemeral_pubkey: string
  iv: string
}

export async function encrypt(plaintext: string, recipientPubkeyHex: string): Promise<EncryptedData> {
  const messageBytes = new TextEncoder().encode(plaintext)
  const recipientPubBytes = hexToBytes(ensure0x(recipientPubkeyHex))

  const ephemPriv = crypto.getRandomValues(new Uint8Array(32))
  const ephemPub = secp.getPublicKey(ephemPriv, true)

  const sharedSecret = secp.getSharedSecret(ephemPriv, recipientPubBytes, true)

  const baseKey = await crypto.subtle.importKey(
    'raw', sharedSecret, { name: 'HKDF' }, false, ['deriveKey']
  )
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ephemPub,
      info: new TextEncoder().encode('ETH-Gate AES-GCM v1'),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  )

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, aesKey, messageBytes
  )

  return {
    ciphertext: bytesToHex(new Uint8Array(ctBuf)),
    ephemeral_pubkey: bytesToHex(ephemPub),
    iv: bytesToHex(iv),
  }
}

export async function decrypt(
  ciphertextHex: string,
  ephemeralPubkeyHex: string,
  ivHex: string,
  privKey: string
): Promise<string> {
  const ephemPubBytes = hexToBytes(ensure0x(ephemeralPubkeyHex))
  const privBytes = hexToBytes(ensure0x(privKey))
  const sharedSecret = secp.getSharedSecret(privBytes, ephemPubBytes, true)

  const baseKey = await crypto.subtle.importKey(
    'raw', sharedSecret, { name: 'HKDF' }, false, ['deriveKey']
  )
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ephemPubBytes,
      info: new TextEncoder().encode('ETH-Gate AES-GCM v1'),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  )

  const iv = hexToBytes(ensure0x(ivHex))
  const ciphertextBytes = hexToBytes(ensure0x(ciphertextHex))
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, aesKey, ciphertextBytes
  )

  return new TextDecoder().decode(plaintextBuf)
}
