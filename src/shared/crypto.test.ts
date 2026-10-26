import { requireAddress } from './address'
import { describe, expect, test } from 'bun:test'
import * as secp from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { encrypt, decrypt } from './crypto'
import {
  MESSAGE_ENVELOPE_VERSION,
  canonicalMessageAad,
  canonicalMessageEnvelope,
  verifyMessageEnvelope,
} from './message-envelope'

const senderPrivateKey = `0x${'11'.repeat(32)}` as const
const recipientPrivateKey = `0x${'22'.repeat(32)}` as const
const sender = privateKeyToAccount(senderPrivateKey)
const recipient = privateKeyToAccount(recipientPrivateKey)
const recipientPublicKey = bytesToHex(secp.getPublicKey(hexToBytes(recipientPrivateKey), true))
const metadata = {
  version: MESSAGE_ENVELOPE_VERSION,
  id: `0x${'44'.repeat(16)}`,
  sender: requireAddress(sender.address),
  recipient: requireAddress(recipient.address),
  ttl: 300,
}
const aad = canonicalMessageAad(metadata)

function vectorRandom(length: number): Uint8Array<ArrayBuffer> {
  if (length === 32) return new Uint8Array(32).fill(0x33)
  if (length === 12) return new Uint8Array(12).fill(0x66)
  throw new Error(`Unexpected random length: ${length}`)
}

describe('authenticated message encryption vector', () => {
  test('encrypts, signs, verifies, and decrypts a stable canonical vector', async () => {
    expect(aad).toBe(
      `hushhash message AAD v2\nVersion: 2\nMessage ID: 0x${'44'.repeat(16)}\nSender: ${requireAddress(sender.address)}\nRecipient: ${requireAddress(recipient.address)}\nTTL: 300`,
    )
    const encrypted = await encrypt('hello envelope', recipientPublicKey, aad, vectorRandom)
    expect(encrypted).toEqual({
      ciphertext: '0x0e6a828c69e13c93b8ccdaf0fb6cf81308ecb9188a24034ed9f9e70a659b',
      ephemeral_pubkey: bytesToHex(secp.getPublicKey(new Uint8Array(32).fill(0x33), true)),
      iv: `0x${'66'.repeat(12)}`,
    })
    const unsigned = {
      ...metadata,
      ct_recipient: encrypted.ciphertext,
      ephemeral_pub_recipient: encrypted.ephemeral_pubkey,
      iv_recipient: encrypted.iv,
      ct_sender: encrypted.ciphertext,
      ephemeral_pub_sender: encrypted.ephemeral_pubkey,
      iv_sender: encrypted.iv,
    }
    const envelope = {
      ...unsigned,
      signature: await sender.signMessage({ message: canonicalMessageEnvelope(unsigned) }),
    }
    expect(envelope.signature).toBe('0x6473c0d66ea0e2817c8aec26397731477ec4100ec27a83c80fd68da27c0a90034284fc5e4b4cb8609a2fb625684679af1bd703c2f65d4c1705bacf8211b88af61c')
    const verified = await verifyMessageEnvelope(envelope)
    expect(verified).not.toBeNull()
    expect(await decrypt(
      verified!.ct_recipient,
      verified!.ephemeral_pub_recipient,
      verified!.iv_recipient,
      recipientPrivateKey,
      canonicalMessageAad(verified!),
    )).toBe('hello envelope')
  })

  test('rejects any authenticated metadata mutation', async () => {
    const encrypted = await encrypt('hello envelope', recipientPublicKey, aad, vectorRandom)
    for (const mutation of [
      aad.replace('Version: 2', 'Version: 1'),
      aad.replace(`0x${'44'.repeat(16)}`, `0x${'45'.repeat(16)}`),
      aad.replace(`Sender: ${requireAddress(sender.address)}`, `Sender: 0x${'12'.repeat(20)}`),
      aad.replace(`Recipient: ${requireAddress(recipient.address)}`, `Recipient: 0x${'23'.repeat(20)}`),
      aad.replace('TTL: 300', 'TTL: 60'),
    ]) {
      await expect(decrypt(
        encrypted.ciphertext,
        encrypted.ephemeral_pubkey,
        encrypted.iv,
        recipientPrivateKey,
        mutation,
      )).rejects.toThrow()
    }
  })
})
