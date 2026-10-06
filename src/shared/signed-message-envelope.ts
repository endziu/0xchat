import type { Address } from './address'
import { bytesToHex } from 'viem'
import { encrypt } from './crypto'
import { signEIP191, type Keypair } from './keypair'
import {
  MESSAGE_ENVELOPE_VERSION,
  MESSAGE_ID_BYTES,
  canonicalMessageAad,
  canonicalMessageEnvelope,
  type MessageEnvelope,
  type MessageMetadata,
} from './message-envelope'

export async function createSignedMessageEnvelope(
  plaintext: string,
  ttl: number,
  sender: Keypair,
  recipientAddress: Address,
  recipientPublicKey: string,
): Promise<MessageEnvelope> {
  const metadata: MessageMetadata = {
    version: MESSAGE_ENVELOPE_VERSION,
    id: bytesToHex(crypto.getRandomValues(new Uint8Array(MESSAGE_ID_BYTES))),
    sender: sender.address,
    recipient: recipientAddress,
    ttl,
  }
  const aad = canonicalMessageAad(metadata)
  const [recipientCopy, senderCopy] = await Promise.all([
    encrypt(plaintext, recipientPublicKey, aad),
    encrypt(plaintext, sender.publicKey, aad),
  ])
  const unsigned = {
    ...metadata,
    ct_recipient: recipientCopy.ciphertext,
    ephemeral_pub_recipient: recipientCopy.ephemeral_pubkey,
    iv_recipient: recipientCopy.iv,
    ct_sender: senderCopy.ciphertext,
    ephemeral_pub_sender: senderCopy.ephemeral_pubkey,
    iv_sender: senderCopy.iv,
  }
  return {
    ...unsigned,
    signature: await signEIP191(canonicalMessageEnvelope(unsigned), sender.privateKey),
  }
}
