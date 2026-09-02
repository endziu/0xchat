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
} from '../../shared/message-envelope'

const senderPrivateKey = `0x${'11'.repeat(32)}` as const
const recipientPrivateKey = `0x${'22'.repeat(32)}` as const
const sender = privateKeyToAccount(senderPrivateKey)
const recipient = privateKeyToAccount(recipientPrivateKey)
const recipientPublicKey = bytesToHex(secp.getPublicKey(hexToBytes(recipientPrivateKey), true))
const metadata = {
  version: MESSAGE_ENVELOPE_VERSION,
  id: `0x${'44'.repeat(16)}`,
  sender: sender.address.toLowerCase(),
  recipient: recipient.address.toLowerCase(),
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
      `0xChat message AAD v1\nVersion: 1\nMessage ID: 0x${'44'.repeat(16)}\nSender: ${sender.address.toLowerCase()}\nRecipient: ${recipient.address.toLowerCase()}\nTTL: 300`,
    )
    const encrypted = await encrypt('hello envelope', recipientPublicKey, aad, vectorRandom)
    expect(encrypted).toEqual({
      ciphertext: '0xa79df7c892565c6d35e048e2dd83560ab463cdc01983953eb2bc775236d5',
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
    expect(envelope.signature).toBe('0x5b6cf4e26468b72ea276e577f9d2d18137281941ca3d4fdb653311b0419218c6333010afb28e0e8804604818865bff62524586c089c29edb423ce69b3d20fef41b')
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
      aad.replace('Version: 1', 'Version: 2'),
      aad.replace(`0x${'44'.repeat(16)}`, `0x${'45'.repeat(16)}`),
      aad.replace(`Sender: ${sender.address.toLowerCase()}`, `Sender: 0x${'12'.repeat(20)}`),
      aad.replace(`Recipient: ${recipient.address.toLowerCase()}`, `Recipient: 0x${'23'.repeat(20)}`),
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
