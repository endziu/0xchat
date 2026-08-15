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
      ciphertext: '0xc58b952fd9937caddeb787f59385ca67b2720b61d51ad7bd3a8b5db8fff3',
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
    expect(envelope.signature).toBe('0xd7856d9d2a63dea6a7a581fe4b597f822c872e4ce55d7e0fe0bf3af95067d26236890bafc632d85f059d4cae5da6a6164631531f277d8c9ce127b57c7fded7fc1b')
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
