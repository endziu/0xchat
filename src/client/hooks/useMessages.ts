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
  // Server-issued cursor for the next older page. (created_at, rowid) is a
  // total order — timestamps alone are ambiguous (Date.now() millisecond
  // ties) — and it stays valid after the page's messages expire.
  const cursorRef = useRef<{ before: number; rowid: number | null } | null>(null)

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

      const page = await api.getMessages(recipientAddress, token, undefined, undefined, PAGE_SIZE)
      if (gen !== loadGenRef.current) return
      const rawMessages = page.messages
      cursorRef.current = page.next_before != null ? { before: page.next_before, rowid: page.next_before_rowid } : null
      const decrypted = await Promise.all(rawMessages.map(decryptMessage))
      if (gen !== loadGenRef.current) return
      setMessages(decrypted.filter((message): message is Message & { plaintext: string } => message !== null).reverse())
      setHasMore(rawMessages.length === PAGE_SIZE)
    } catch (err) {
      console.error('Failed to load messages:', err)
    } finally {
      if (gen === loadGenRef.current) setLoading(false)
    }
  }, [recipientAddress, identity, token, decryptMessage])

  // Fetches the next older page and returns it in ascending order, without
  // touching the message list. The pane prepends via prependMessages so it
  // can signal the prepend before the render commits.
  const fetchOlder = useCallback(async (): Promise<(Message & { plaintext: string })[]> => {
    if (!recipientAddress || !identity || !token || loadingOlder || !hasMore) return []
    const cursor = cursorRef.current
    if (!cursor) return []

    const gen = loadGenRef.current
    setLoadingOlder(true)
    try {
      const page = await api.getMessages(recipientAddress, token, cursor.before, cursor.rowid ?? undefined, PAGE_SIZE)
      if (gen !== loadGenRef.current) return []
      cursorRef.current = page.next_before != null ? { before: page.next_before, rowid: page.next_before_rowid } : null
      setHasMore(page.messages.length === PAGE_SIZE)
      const decrypted = await Promise.all(page.messages.map(decryptMessage))
      if (gen !== loadGenRef.current) return []
      const existingIds = new Set(messages.map(message => message.id))
      return decrypted
        .filter((message): message is Message & { plaintext: string } => message !== null)
        .filter(message => !existingIds.has(message.id))
        .reverse() // pages arrive newest-first
    } catch (err) {
      console.error('Failed to load older messages:', err)
      return []
    } finally {
      if (gen === loadGenRef.current) setLoadingOlder(false)
    }
  }, [recipientAddress, identity, token, loadingOlder, hasMore, messages, decryptMessage])

  const prependMessages = useCallback((fresh: (Message & { plaintext: string })[]) => {
    if (fresh.length === 0) return
    setMessages(prev => {
      const freshIds = new Set(fresh.map(message => message.id))
      return [...fresh, ...prev.filter(message => !freshIds.has(message.id))]
    })
  }, [])

  // Clear messages immediately when recipient changes, then load new ones.
  // The generation bump also invalidates in-flight fetches from the
  // previous conversation.
  useEffect(() => {
    loadGenRef.current++
    cursorRef.current = null
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

  return { messages, setMessages, loading, hasMore, loadingOlder, fetchOlder, prependMessages, sendMessage, recipientPubkey, addMessage, refresh: loadMessages }
}
