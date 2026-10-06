import * as secp from '@noble/secp256k1'
import { hexToBytes, bytesToHex } from 'viem'
import { ensure0x } from './hex'

export interface EncryptedData {
  ciphertext: string
  ephemeral_pubkey: string
  iv: string
}

type RandomBytes = (length: number) => Uint8Array<ArrayBuffer>

const secureRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length))

async function deriveAesKey(
  sharedSecret: Uint8Array<ArrayBuffer>,
  ephemeralPublicKey: Uint8Array<ArrayBuffer>,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw', sharedSecret, { name: 'HKDF' }, false, ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ephemeralPublicKey,
      info: new TextEncoder().encode('0xChat AES-GCM v2'),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  )
}

export async function encrypt(
  plaintext: string,
  recipientPubkeyHex: string,
  additionalData: string,
  randomBytes: RandomBytes = secureRandomBytes,
): Promise<EncryptedData> {
  const messageBytes = new TextEncoder().encode(plaintext)
  const recipientPubBytes = hexToBytes(ensure0x(recipientPubkeyHex))

  const ephemPriv = randomBytes(32)
  const ephemPub = secp.getPublicKey(ephemPriv, true)

  const sharedSecret = new Uint8Array(secp.getSharedSecret(ephemPriv, recipientPubBytes, true))
  const aesKey = await deriveAesKey(sharedSecret, new Uint8Array(ephemPub), 'encrypt')

  const iv = randomBytes(12)
  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(additionalData) }, aesKey, messageBytes
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
  privKey: string,
  additionalData: string,
): Promise<string> {
  const ephemPubBytes = hexToBytes(ensure0x(ephemeralPubkeyHex))
  const privBytes = hexToBytes(ensure0x(privKey))
  const sharedSecret = new Uint8Array(secp.getSharedSecret(privBytes, ephemPubBytes, true))
  const aesKey = await deriveAesKey(sharedSecret, new Uint8Array(ephemPubBytes), 'decrypt')

  const iv = new Uint8Array(hexToBytes(ensure0x(ivHex)))
  const ciphertextBytes = new Uint8Array(hexToBytes(ensure0x(ciphertextHex)))
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(additionalData) }, aesKey, ciphertextBytes
  )

  return new TextDecoder().decode(plaintextBuf)
}
