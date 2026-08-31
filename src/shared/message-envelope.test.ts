import { describe, expect, test } from 'bun:test'
import * as secp from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  MAX_CIPHERTEXT_HEX_LEN,
  MESSAGE_ENVELOPE_VERSION,
  canonicalMessageAad,
  canonicalMessageEnvelope,
  parseMessageEnvelope,
  verifyMessageEnvelope,
  type MessageEnvelope,
} from './message-envelope'

const senderKey = `0x${'11'.repeat(32)}` as const
const recipientKey = `0x${'22'.repeat(32)}` as const
const sender = privateKeyToAccount(senderKey)
const recipient = privateKeyToAccount(recipientKey)
const ephemeral = bytesToHex(secp.getPublicKey(hexToBytes(`0x${'33'.repeat(32)}`), true))

async function signedEnvelope(): Promise<MessageEnvelope> {
  const unsigned = {
    version: MESSAGE_ENVELOPE_VERSION,
    id: `0x${'44'.repeat(16)}`,
    sender: sender.address.toLowerCase(),
    recipient: recipient.address.toLowerCase(),
    ttl: 300,
    ct_recipient: `0x${'55'.repeat(32)}`,
    ephemeral_pub_recipient: ephemeral,
    iv_recipient: `0x${'66'.repeat(12)}`,
    ct_sender: `0x${'77'.repeat(32)}`,
    ephemeral_pub_sender: ephemeral,
    iv_sender: `0x${'88'.repeat(12)}`,
  }
  return {
    ...unsigned,
    signature: await sender.signMessage({ message: canonicalMessageEnvelope(unsigned) }),
  }
}

describe('message envelope protocol', () => {
  test('has stable canonical metadata and envelope encodings', async () => {
    const envelope = await signedEnvelope()
    const { signature: _, ...unsigned } = envelope
    expect(canonicalMessageAad(envelope)).toBe(
      `0xChat message AAD v1\nVersion: 1\nMessage ID: 0x${'44'.repeat(16)}\nSender: ${sender.address.toLowerCase()}\nRecipient: ${recipient.address.toLowerCase()}\nTTL: 300`,
    )
    expect(canonicalMessageEnvelope(unsigned)).toBe(
      `0xChat signed message envelope v1\nVersion: 1\nMessage ID: 0x${'44'.repeat(16)}\nSender: ${sender.address.toLowerCase()}\nRecipient: ${recipient.address.toLowerCase()}\nTTL: 300\nRecipient ciphertext: 0x${'55'.repeat(32)}\nRecipient ephemeral public key: ${ephemeral}\nRecipient IV: 0x${'66'.repeat(12)}\nSender ciphertext: 0x${'77'.repeat(32)}\nSender ephemeral public key: ${ephemeral}\nSender IV: 0x${'88'.repeat(12)}`,
    )
    expect(envelope.signature).toBe(
      '0x841923c88510f1f8a958d1c3bb59a400f4a970a808934fd6e261bd056820e37a755c5d7fd47f206460b7cb238e4e6071c98bf000673980ff2ba3e3027368c29a1c',
    )
    expect(await verifyMessageEnvelope(envelope)).toEqual(envelope)
  })

  test('rejects mutations to every signed field, signature, and wrong signer', async () => {
    const envelope = await signedEnvelope()
    const mutations: Partial<Record<keyof MessageEnvelope, unknown>>[] = [
      { version: 2 },
      { id: `0x${'45'.repeat(16)}` },
      { sender: recipient.address.toLowerCase() },
      { recipient: sender.address.toLowerCase() },
      { ttl: 60 },
      { ct_recipient: `0x${'56'.repeat(32)}` },
      { ephemeral_pub_recipient: bytesToHex(secp.getPublicKey(hexToBytes(`0x${'34'.repeat(32)}`), true)) },
      { iv_recipient: `0x${'67'.repeat(12)}` },
      { ct_sender: `0x${'78'.repeat(32)}` },
      { ephemeral_pub_sender: bytesToHex(secp.getPublicKey(hexToBytes(`0x${'35'.repeat(32)}`), true)) },
      { iv_sender: `0x${'89'.repeat(12)}` },
      { signature: `0x${'00'.repeat(65)}` },
    ]
    for (const mutation of mutations) {
      expect(await verifyMessageEnvelope({ ...envelope, ...mutation })).toBeNull()
    }

    const { signature: _, ...unsigned } = envelope
    const wrongSignature = await recipient.signMessage({ message: canonicalMessageEnvelope(unsigned) })
    expect(await verifyMessageEnvelope({ ...envelope, signature: wrongSignature })).toBeNull()
  })

  test('rejects malformed and noncanonical envelopes', async () => {
    const envelope = await signedEnvelope()
    expect(parseMessageEnvelope({ ...envelope, extra: true })).toBeNull()
    expect(parseMessageEnvelope({ ...envelope, sender: envelope.sender.toUpperCase() })).toBeNull()
    expect(parseMessageEnvelope({ ...envelope, ephemeral_pub_sender: `0x02${'00'.repeat(32)}` })).toBeNull()
    expect(parseMessageEnvelope({ ...envelope, id: 'legacy-server-id' })).toBeNull()
  })

  test('accepts ciphertext exactly at the size cap and rejects one byte over', async () => {
    const envelope = await signedEnvelope()
    const maxCiphertext = `0x${'ab'.repeat((MAX_CIPHERTEXT_HEX_LEN - 2) / 2)}`
    expect(maxCiphertext.length).toBe(MAX_CIPHERTEXT_HEX_LEN)
    expect(parseMessageEnvelope({ ...envelope, ct_recipient: maxCiphertext })).not.toBeNull()

    const oversizedCiphertext = `${maxCiphertext}ab`
    expect(parseMessageEnvelope({ ...envelope, ct_recipient: oversizedCiphertext })).toBeNull()
  })
})
