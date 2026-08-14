import * as secp from '@noble/secp256k1'
import { hexToBytes, recoverMessageAddress } from 'viem'

export const MESSAGE_ENVELOPE_VERSION = 1 as const
export const MESSAGE_ID_BYTES = 16

export interface MessageMetadata {
  version: typeof MESSAGE_ENVELOPE_VERSION
  id: string
  sender: string
  recipient: string
  ttl: number
}

export interface MessageEnvelope extends MessageMetadata {
  ct_recipient: string
  ephemeral_pub_recipient: string
  iv_recipient: string
  ct_sender: string
  ephemeral_pub_sender: string
  iv_sender: string
  signature: string
}

export interface DeliveredMessage extends MessageEnvelope {
  created_at: number
  expires_at: number
}

const ADDRESS = /^0x[0-9a-f]{40}$/
const MESSAGE_ID = /^0x[0-9a-f]{32}$/
const SIGNATURE = /^0x[0-9a-f]{130}$/
const HEX = /^0x(?:[0-9a-f]{2})+$/
const ENVELOPE_KEYS = [
  'version', 'id', 'sender', 'recipient', 'ttl',
  'ct_recipient', 'ephemeral_pub_recipient', 'iv_recipient',
  'ct_sender', 'ephemeral_pub_sender', 'iv_sender', 'signature',
].sort()
const DELIVERED_KEYS = [...ENVELOPE_KEYS, 'created_at', 'expires_at'].sort()

export function canonicalMessageAad(metadata: MessageMetadata): string {
  return [
    '0xChat message AAD v1',
    `Version: ${metadata.version}`,
    `Message ID: ${metadata.id}`,
    `Sender: ${metadata.sender}`,
    `Recipient: ${metadata.recipient}`,
    `TTL: ${metadata.ttl}`,
  ].join('\n')
}

export function canonicalMessageEnvelope(envelope: Omit<MessageEnvelope, 'signature'>): string {
  return [
    '0xChat signed message envelope v1',
    `Version: ${envelope.version}`,
    `Message ID: ${envelope.id}`,
    `Sender: ${envelope.sender}`,
    `Recipient: ${envelope.recipient}`,
    `TTL: ${envelope.ttl}`,
    `Recipient ciphertext: ${envelope.ct_recipient}`,
    `Recipient ephemeral public key: ${envelope.ephemeral_pub_recipient}`,
    `Recipient IV: ${envelope.iv_recipient}`,
    `Sender ciphertext: ${envelope.ct_sender}`,
    `Sender ephemeral public key: ${envelope.ephemeral_pub_sender}`,
    `Sender IV: ${envelope.iv_sender}`,
  ].join('\n')
}

function validCompressedPoint(value: unknown): value is string {
  if (typeof value !== 'string' || !/^0x0[23][0-9a-f]{64}$/.test(value)) return false
  try {
    secp.Point.fromBytes(hexToBytes(value as `0x${string}`))
    return true
  } catch {
    return false
  }
}

function validCiphertext(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 34 // AES-GCM's 16-byte authentication tag, even for empty plaintext
    && value.length <= 2_000_002
    && HEX.test(value)
}

function validIv(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-f]{24}$/.test(value)
}

export function parseMessageEnvelope(input: unknown): MessageEnvelope | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  if (Object.keys(value).sort().join(',') !== ENVELOPE_KEYS.join(',')) return null
  if (value['version'] !== MESSAGE_ENVELOPE_VERSION) return null
  if (typeof value['id'] !== 'string' || !MESSAGE_ID.test(value['id'])) return null
  if (typeof value['sender'] !== 'string' || !ADDRESS.test(value['sender'])) return null
  if (typeof value['recipient'] !== 'string' || !ADDRESS.test(value['recipient'])) return null
  if (!Number.isSafeInteger(value['ttl']) || (value['ttl'] as number) <= 0) return null
  if (!validCiphertext(value['ct_recipient']) || !validCiphertext(value['ct_sender'])) return null
  if (!validCompressedPoint(value['ephemeral_pub_recipient']) || !validCompressedPoint(value['ephemeral_pub_sender'])) return null
  if (!validIv(value['iv_recipient']) || !validIv(value['iv_sender'])) return null
  if (typeof value['signature'] !== 'string' || !SIGNATURE.test(value['signature'])) return null
  return value as unknown as MessageEnvelope
}

export async function verifyMessageEnvelope(input: unknown): Promise<MessageEnvelope | null> {
  const envelope = parseMessageEnvelope(input)
  if (!envelope) return null
  try {
    const { signature: _signature, ...unsigned } = envelope
    const recovered = await recoverMessageAddress({
      message: canonicalMessageEnvelope(unsigned),
      signature: envelope.signature as `0x${string}`,
    })
    return recovered.toLowerCase() === envelope.sender ? envelope : null
  } catch {
    return null
  }
}

export async function verifyDeliveredMessage(input: unknown): Promise<DeliveredMessage | null> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  if (Object.keys(value).sort().join(',') !== DELIVERED_KEYS.join(',')) return null
  const { created_at: createdAt, expires_at: expiresAt, ...candidate } = value
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt)) return null
  if ((expiresAt as number) !== (createdAt as number) + (candidate['ttl'] as number) * 1000) return null
  const envelope = await verifyMessageEnvelope(candidate)
  return envelope ? { ...envelope, created_at: createdAt as number, expires_at: expiresAt as number } : null
}

export function isEnvelopeParticipant(
  envelope: MessageEnvelope,
  identityAddress: string,
  counterpartyAddress?: string,
): boolean {
  const identity = identityAddress.toLowerCase()
  if (envelope.sender !== identity && envelope.recipient !== identity) return false
  if (!counterpartyAddress) return true
  const counterparty = counterpartyAddress.toLowerCase()
  return (envelope.sender === identity && envelope.recipient === counterparty)
    || (envelope.sender === counterparty && envelope.recipient === identity)
}
