import { bytesToHex } from 'viem'
import type { Keypair } from './burner'
import { signEIP191 } from './burner'
import { encrypt } from './crypto'
import {
  MESSAGE_ENVELOPE_VERSION,
  canonicalMessageAad,
  canonicalMessageEnvelope,
  type MessageEnvelope,
  type MessageMetadata,
} from '../../shared/message-envelope'

export async function createSignedMessageEnvelope(
  plaintext: string,
  ttl: number,
  sender: Keypair,
  recipientAddress: string,
  recipientPublicKey: string,
): Promise<MessageEnvelope> {
  const metadata: MessageMetadata = {
    version: MESSAGE_ENVELOPE_VERSION,
    id: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    sender: sender.address.toLowerCase(),
    recipient: recipientAddress.toLowerCase(),
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
