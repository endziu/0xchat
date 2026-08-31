import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { api, Message } from '../lib/api'
import { decrypt } from '../lib/crypto'
import { createSignedMessageEnvelope } from '../lib/message-envelope'
import { Keypair } from '../lib/burner'
import {
  canonicalMessageAad,
  isEnvelopeParticipant,
  verifyDeliveredMessage,
} from '../../shared/message-envelope'

export function useMessages(recipientAddress: string | null, identity: Keypair | null, token: string | null) {
  const [messages, setMessages] = useState<(Message & { plaintext: string })[]>([])
  const [loading, setLoading] = useState(false)
  const [recipientPubkey, setRecipientPubkey] = useState<string | null>(null)
  const timerRef = useRef<Map<string, NodeJS.Timeout>>(new Map())

  const decryptMessage = useCallback(async (input: unknown): Promise<(Message & { plaintext: string }) | null> => {
    if (!identity || !recipientAddress) return null
    const msg = await verifyDeliveredMessage(input)
    if (!msg || !isEnvelopeParticipant(msg, identity.address, recipientAddress)) {
      console.error('Rejected unauthenticated or misaddressed message envelope')
      return null
    }
    const isMine = msg.sender === identity.address.toLowerCase()
    const ciphertext = isMine ? msg.ct_sender : msg.ct_recipient
    const ephPub = isMine ? msg.ephemeral_pub_sender : msg.ephemeral_pub_recipient
    const iv = isMine ? msg.iv_sender : msg.iv_recipient

    try {
      const plaintext = await decrypt(
        ciphertext,
        ephPub,
        iv,
        identity.privateKey,
        canonicalMessageAad(msg),
      )
      return { ...msg, plaintext }
    } catch (err) {
      console.error('Rejected undecryptable message envelope:', err)
      return null
    }
  }, [identity, recipientAddress])

  const loadMessages = useCallback(async () => {
    if (!recipientAddress || !identity || !token) {
      setMessages([])
      setRecipientPubkey(null)
      return
    }

    setLoading(true)
    try {
      const { pubkey } = await api.getPubkey(recipientAddress)
      setRecipientPubkey(pubkey)

      const { messages: rawMessages } = await api.getMessages(recipientAddress, token)
      const decrypted = await Promise.all(rawMessages.map(decryptMessage))
      setMessages(decrypted.filter((message): message is Message & { plaintext: string } => message !== null).reverse())
    } catch (err) {
      console.error('Failed to load messages:', err)
    } finally {
      setLoading(false)
    }
  }, [recipientAddress, identity, token, decryptMessage])

  // Clear messages immediately when recipient changes, then load new ones
  useEffect(() => {
    setMessages([])
    setRecipientPubkey(null)
  }, [recipientAddress])

  useEffect(() => {
    loadMessages()
  }, [loadMessages])

  // Set up expiry timers for messages
  useEffect(() => {
    const now = Date.now()
    const messageIds = new Set(messages.map(m => m.id))

    // Clean up timers for removed messages
    for (const [id] of timerRef.current) {
      if (!messageIds.has(id)) {
        const timer = timerRef.current.get(id)
        if (timer) clearTimeout(timer)
        timerRef.current.delete(id)
      }
    }

    // Set timers for new messages
    for (const msg of messages) {
      if (timerRef.current.has(msg.id)) continue

      const timeUntilExpiry = msg.expires_at - now
      if (timeUntilExpiry <= 0) {
        // Already expired, remove immediately
        setMessages(prev => prev.filter(m => m.id !== msg.id))
      } else {
        // Set timer to remove when it expires
        const timer = setTimeout(() => {
          setMessages(prev => prev.filter(m => m.id !== msg.id))
        }, timeUntilExpiry)
        timerRef.current.set(msg.id, timer)
      }
    }
  }, [messages])

  // Clean up all timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of timerRef.current.values()) {
        if (timer) clearTimeout(timer)
      }
      timerRef.current.clear()
    }
  }, [])

  const sendMessage = async (plaintext: string, ttl: number) => {
    if (!recipientAddress || !identity || !token) {
      throw new Error('Not ready to send message (missing identity or session)')
    }
    if (!recipientPubkey) {
      throw new Error('Recipient has not registered their encryption key yet')
    }

    const envelope = await createSignedMessageEnvelope(
      plaintext,
      ttl,
      identity,
      recipientAddress,
      recipientPubkey,
    )

    try {
      return await api.sendMessage(envelope, token)
    } catch (err: any) {
      throw new Error(err.message || 'Server rejected the message')
    }
  }

  const addMessage = useCallback(async (input: unknown) => {
    const decrypted = await decryptMessage(input)
    if (!decrypted) return
    setMessages(prev => {
      if (prev.find(message => message.id === decrypted.id)) return prev
      return [...prev, decrypted]
    })
  }, [decryptMessage])

  return { messages, setMessages, loading, sendMessage, recipientPubkey, addMessage, refresh: loadMessages }
}
