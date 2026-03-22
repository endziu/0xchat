import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { api, Message } from '../lib/api'
import { encrypt, decrypt } from '../lib/crypto'
import { Keypair } from '../lib/burner'

export function useMessages(recipientAddress: string | null, identity: Keypair | null, token: string | null) {
  const [messages, setMessages] = useState<(Message & { plaintext: string })[]>([])
  const [loading, setLoading] = useState(false)
  const [recipientPubkey, setRecipientPubkey] = useState<string | null>(null)
  const timerRef = useRef<Map<string, NodeJS.Timeout>>(new Map())

  const decryptMessage = useCallback(async (msg: Message): Promise<Message & { plaintext: string }> => {
    if (!identity) throw new Error('Identity not available')
    const isMine = msg.sender.toLowerCase() === identity.address.toLowerCase()
    const ciphertext = isMine ? msg.ct_sender : msg.ct_recipient
    const ephPub = isMine ? msg.ephemeral_pub_sender : msg.ephemeral_pub_recipient
    const iv = isMine ? msg.iv_sender : msg.iv_recipient

    try {
      const plaintext = await decrypt(ciphertext, ephPub, iv, identity.privateKey)
      return { ...msg, plaintext }
    } catch (err) {
      console.error('Failed to decrypt message:', err)
      return { ...msg, plaintext: '[Decryption error]' }
    }
  }, [identity])

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

      const { messages: rawMessages } = await api.getMessages(recipientAddress)
      const decrypted = await Promise.all(rawMessages.map(decryptMessage))
      setMessages(decrypted.reverse())
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

    const encRecipient = await encrypt(plaintext, recipientPubkey)
    const encSender = await encrypt(plaintext, identity.publicKey)

    try {
      return await api.sendMessage({
        recipient: recipientAddress,
        ct_recipient: encRecipient.ciphertext,
        ephemeral_pub_recipient: encRecipient.ephemeral_pubkey,
        iv_recipient: encRecipient.iv,
        ct_sender: encSender.ciphertext,
        ephemeral_pub_sender: encSender.ephemeral_pubkey,
        iv_sender: encSender.iv,
        ttl,
      })
    } catch (err: any) {
      throw new Error(err.message || 'Server rejected the message')
    }
  }

  const addMessage = useCallback(async (msg: Message) => {
    try {
      const decrypted = await decryptMessage(msg)
      setMessages(prev => {
        if (prev.find(m => m.id === msg.id)) return prev
        return [...prev, decrypted]
      })
    } catch (err) {
      console.error('Failed to decrypt incoming message:', err)
    }
  }, [decryptMessage])

  return { messages, setMessages, loading, sendMessage, recipientPubkey, addMessage, refresh: loadMessages }
}
