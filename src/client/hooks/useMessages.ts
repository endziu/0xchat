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

const PAGE_SIZE = 50

export function useMessages(recipientAddress: string | null, identity: Keypair | null, token: string | null) {
  const [messages, setMessages] = useState<(Message & { plaintext: string })[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [recipientPubkey, setRecipientPubkey] = useState<string | null>(null)
  const timerRef = useRef<Map<string, NodeJS.Timeout>>(new Map())
  const loadGenRef = useRef(0)
  // Oldest created_at seen from the server, kept even after those messages
  // expire so "load older" still has a cursor when the visible list is empty.
  const oldestCursorRef = useRef<number | null>(null)

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
      setHasMore(false)
      return
    }

    const gen = loadGenRef.current
    setLoading(true)
    try {
      const { pubkey } = await api.getPubkey(recipientAddress)
      if (gen !== loadGenRef.current) return
      setRecipientPubkey(pubkey)

      const { messages: rawMessages } = await api.getMessages(recipientAddress, undefined, PAGE_SIZE)
      if (gen !== loadGenRef.current) return
      if (rawMessages.length > 0) {
        oldestCursorRef.current = (rawMessages[rawMessages.length - 1] as { created_at: number }).created_at
      }
      const decrypted = await Promise.all(rawMessages.map(decryptMessage))
      setMessages(decrypted.filter((message): message is Message & { plaintext: string } => message !== null).reverse())
      setHasMore(rawMessages.length === PAGE_SIZE)
    } catch (err) {
      console.error('Failed to load messages:', err)
    } finally {
      if (gen === loadGenRef.current) setLoading(false)
    }
  }, [recipientAddress, identity, token, decryptMessage])

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!recipientAddress || !identity || !token || loadingOlder || !hasMore) return 0
    const cursor = messages[0]?.created_at ?? oldestCursorRef.current
    if (cursor == null) return 0

    const gen = loadGenRef.current
    setLoadingOlder(true)
    try {
      // Pages arrive newest-first; the server's `before` cutoff is strict, so
      // +1 keeps messages sharing the boundary millisecond reachable (the
      // id-dedupe below drops the repeats) and reverse restores ascending
      // order for the prepend.
      const { messages: rawMessages } = await api.getMessages(recipientAddress, cursor + 1, PAGE_SIZE)
      if (gen !== loadGenRef.current) return 0
      if (rawMessages.length > 0) {
        oldestCursorRef.current = (rawMessages[rawMessages.length - 1] as { created_at: number }).created_at
      }
      const decrypted = await Promise.all(rawMessages.map(decryptMessage))
      if (gen !== loadGenRef.current) return 0
      const existingIds = new Set(messages.map(message => message.id))
      const fresh = decrypted
        .filter((message): message is Message & { plaintext: string } => message !== null)
        .filter(message => !existingIds.has(message.id))
        .reverse()
      if (fresh.length > 0) {
        setMessages(prev => {
          const freshIds = new Set(fresh.map(message => message.id))
          return [...fresh, ...prev.filter(message => !freshIds.has(message.id))]
        })
      }
      // A full page that adds nothing means the cursor cannot progress
      // (pathological same-timestamp tie) — stop offering further pages.
      setHasMore(rawMessages.length === PAGE_SIZE && fresh.length > 0)
      return fresh.length
    } catch (err) {
      console.error('Failed to load older messages:', err)
      return 0
    } finally {
      if (gen === loadGenRef.current) setLoadingOlder(false)
    }
  }, [recipientAddress, identity, token, loadingOlder, hasMore, messages, decryptMessage])

  // Clear messages immediately when recipient changes, then load new ones.
  // The generation bump also invalidates in-flight fetches from the
  // previous conversation.
  useEffect(() => {
    loadGenRef.current++
    oldestCursorRef.current = null
    setMessages([])
    setRecipientPubkey(null)
    setHasMore(false)
    setLoadingOlder(false)
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
      return await api.sendMessage(envelope)
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

  return { messages, setMessages, loading, hasMore, loadingOlder, loadOlder, sendMessage, recipientPubkey, addMessage, refresh: loadMessages }
}
