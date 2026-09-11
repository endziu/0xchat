import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { api } from '../lib/api'
import { decrypt } from '../lib/crypto'
import { createSignedMessageEnvelope } from '../lib/message-envelope'
import { Keypair } from '../lib/burner'
import { errorMessage } from '../lib/errors'
import { markConversationSeen } from '../lib/contacts'
import { ConversationMessages, type DecryptedMessage } from '../lib/conversation-messages'
import { isWindowAttentive, useWindowAttention } from './useWindowAttention'
import {
  canonicalMessageAad,
  isEnvelopeParticipant,
  parseExpiryUpdate,
  verifyDeliveredMessage,
} from '../../shared/message-envelope'

const PAGE_SIZE = 50
// The opening and state endpoints accept at most 100 IDs per request.
const ID_BATCH = 100
// A refresh repeats for messages loaded while it was in flight, a bounded
// number of times.
const MAX_REFRESH_ROUNDS = 3
// setTimeout overflows above 2^31 - 1 ms.
const MAX_TIMER_MS = 2 ** 31 - 1

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

/**
 * Messages of the selected conversation. `connected` is the live stream's
 * state: loaded lifecycle state is synchronized only after the initial load
 * completes on an unbroken connection, or a complete state refresh finishes
 * after (re)connecting. An open transport alone is not enough.
 */
export function useMessages(recipientAddress: string | null, identity: Keypair | null, token: string | null, connected: boolean) {
  const [, setVersion] = useState(0)
  const rerender = useCallback(() => setVersion(version => version + 1), [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [olderError, setOlderError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [recipientPubkey, setRecipientPubkey] = useState<string | null>(null)
  // One store and generation per identity, conversation and session. Replacing
  // them during render keeps a previous conversation's messages off screen,
  // and the generation bump invalidates its in-flight work.
  const scope = `${identity?.address ?? ''}:${recipientAddress ?? ''}:${token ?? ''}`
  const scopeRef = useRef<string | null>(null)
  const storeRef = useRef<ConversationMessages>(new ConversationMessages(''))
  const loadGenRef = useRef(0)
  const loadedRef = useRef(false)
  const synchronizedRef = useRef(false)
  if (scopeRef.current !== scope) {
    scopeRef.current = scope
    storeRef.current = new ConversationMessages(identity?.address ?? '')
    loadGenRef.current++
    loadedRef.current = false
    synchronizedRef.current = false
  }
  // Each change of connection state starts a new epoch; losing the stream
  // ends synchronization and invalidates refreshes begun before.
  const connectedRef = useRef(connected)
  const epochRef = useRef(0)
  if (connectedRef.current !== connected) {
    connectedRef.current = connected
    epochRef.current++
    if (!connected) synchronizedRef.current = false
  }
  // Server-issued cursor for the next older page. (created_at, rowid) is a
  // total order — timestamps alone are ambiguous (Date.now() millisecond
  // ties) — and it stays valid after the page's messages expire.
  const cursorRef = useRef<{ before: number; rowid: number | null } | null>(null)

  const decryptMessage = useCallback(async (input: unknown): Promise<DecryptedMessage | null> => {
    if (!identity || !recipientAddress) return null
    const msg = await verifyDeliveredMessage(input)
    if (!msg || !isEnvelopeParticipant(msg, identity.address)) {
      console.error('Rejected unauthenticated or misaddressed message envelope')
      return null
    }
    // Live events from other conversations share the stream.
    if (!isEnvelopeParticipant(msg, identity.address, recipientAddress)) return null
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

  const decryptAll = useCallback(async (inputs: unknown[]): Promise<DecryptedMessage[]> =>
    (await Promise.all(inputs.map(decryptMessage))).filter((message): message is DecryptedMessage => message !== null),
  [decryptMessage])

  // Requests opening for every pending incoming message, but only while the
  // selected conversation's window is attentive — checked as each request is
  // made, after any decryption. Plaintext stays hidden until the server
  // confirms each ID. Requests run one after another, so messages arriving
  // during one share the next instead of each spending the opening budget.
  const openingQueueRef = useRef<{ gen: number; queue: Promise<void> }>({ gen: 0, queue: Promise.resolve() })
  const openPending = useCallback((): Promise<void> => {
    const run = async (): Promise<void> => {
      if (!recipientAddress || !token || !isWindowAttentive()) return
      const gen = loadGenRef.current
      const store = storeRef.current
      const ids = store.takePending()
      if (ids.length === 0) return
      await Promise.all(batches(ids, ID_BATCH).map(async batch => {
        let response: unknown
        try {
          response = await api.openMessages(recipientAddress, batch, token)
        } catch (err) {
          console.error('Failed to open messages:', err)
          if (gen === loadGenRef.current) store.failOpening(batch)
          return
        }
        if (gen === loadGenRef.current) store.confirmOpening(batch, response)
      }))
      if (gen === loadGenRef.current) rerender()
    }
    // A new conversation, identity or session never waits behind the
    // previous one's requests.
    const scopeGen = loadGenRef.current
    const previous = openingQueueRef.current.gen === scopeGen ? openingQueueRef.current.queue : Promise.resolve()
    const queued = previous.then(run, run)
    openingQueueRef.current = { gen: scopeGen, queue: queued }
    return queued
  }, [recipientAddress, token, rerender])

  // Refreshes every loaded message's lifecycle once the stream is open. Only
  // a complete refresh on the current connection restores content whose
  // deadline could have changed meanwhile, such as an unopened sender copy.
  const syncingRef = useRef<string | null>(null)
  const synchronize = useCallback(async (): Promise<void> => {
    if (!recipientAddress || !token || !connectedRef.current || synchronizedRef.current) return
    const gen = loadGenRef.current
    const epoch = epochRef.current
    const attempt = `${gen}:${epoch}`
    if (syncingRef.current === attempt) return
    syncingRef.current = attempt
    const current = () => gen === loadGenRef.current && epoch === epochRef.current
    const store = storeRef.current
    try {
      // Messages that land while a round is in flight, such as an older page
      // requested before reconnecting, are looked up in the next round.
      const refreshed = new Set<string>()
      for (let round = 0; round < MAX_REFRESH_ROUNDS; round++) {
        const ids = store.ids().filter(id => !refreshed.has(id))
        if (ids.length === 0 && round > 0) break
        const responses = await Promise.all(batches(ids, ID_BATCH).map(async batch =>
          ({ batch, response: await api.getMessageStates(recipientAddress, batch, token) })))
        if (!current()) return
        const complete = responses.map(({ batch, response }) => store.applyStates(batch, response)).every(Boolean)
        if (!complete) throw new Error('Invalid message state response')
        for (const id of ids) refreshed.add(id)
      }
      synchronizedRef.current = true
      store.sweep(Date.now(), { synchronized: true })
      setError(null)
      rerender()
    } catch (err) {
      console.error('Failed to refresh messages:', err)
      if (current()) setError(errorMessage(err, 'Failed to refresh messages'))
    } finally {
      if (syncingRef.current === attempt) syncingRef.current = null
    }
  }, [recipientAddress, token, rerender])

  const loadMessages = useCallback(async () => {
    if (!recipientAddress || !identity || !token) {
      setRecipientPubkey(null)
      setHasMore(false)
      setError(null)
      setOlderError(null)
      return
    }

    const gen = loadGenRef.current
    const epoch = epochRef.current
    setLoading(true)
    setError(null)
    setOlderError(null)
    try {
      const { pubkey } = await api.getPubkey(recipientAddress)
      if (gen !== loadGenRef.current) return
      setRecipientPubkey(pubkey)

      const page = await api.getMessages(recipientAddress, token, undefined, undefined, PAGE_SIZE)
      if (gen !== loadGenRef.current) return
      cursorRef.current = page.next_before != null ? { before: page.next_before, rowid: page.next_before_rowid } : null
      const decrypted = await decryptAll(page.messages)
      if (gen !== loadGenRef.current) return
      storeRef.current.add(decrypted.reverse())
      setHasMore(page.messages.length === PAGE_SIZE)
      loadedRef.current = true
      // The page is authoritative if the stream stayed up throughout;
      // otherwise its state needs a refresh on the current connection.
      if (connectedRef.current && epoch === epochRef.current) synchronizedRef.current = true
      else void synchronize()
      rerender()
      void openPending()
    } catch (err) {
      console.error('Failed to load messages:', err)
      if (gen === loadGenRef.current) setError(errorMessage(err, 'Failed to load messages'))
    } finally {
      if (gen === loadGenRef.current) setLoading(false)
    }
  }, [recipientAddress, identity, token, decryptAll, openPending, synchronize, rerender])

  // Fetches the next older page and returns its displayable messages in
  // ascending order. They stay staged, off screen, until the pane prepends
  // them via prependMessages, so it can signal the prepend before the render
  // commits.
  const fetchOlder = useCallback(async (): Promise<DecryptedMessage[]> => {
    if (!recipientAddress || !identity || !token || loadingOlder || !hasMore) return []
    const cursor = cursorRef.current
    if (!cursor) return []

    const gen = loadGenRef.current
    const store = storeRef.current
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const page = await api.getMessages(recipientAddress, token, cursor.before, cursor.rowid ?? undefined, PAGE_SIZE)
      if (gen !== loadGenRef.current) return []
      cursorRef.current = page.next_before != null ? { before: page.next_before, rowid: page.next_before_rowid } : null
      setHasMore(page.messages.length === PAGE_SIZE)
      const decrypted = await decryptAll(page.messages)
      if (gen !== loadGenRef.current) return []
      store.add(decrypted.reverse(), { staged: true })
      await openPending()
      if (gen !== loadGenRef.current) return []
      const conditions = { eligible: isWindowAttentive(), synchronized: synchronizedRef.current }
      const fresh = store.display(Date.now(), conditions, { staged: true })
      if (fresh.length === 0) {
        store.unstage()
        rerender()
      }
      return fresh
    } catch (err) {
      console.error('Failed to load older messages:', err)
      // The cursor only advances on success, so the load-older button is
      // still the retry — it just needs to say that the last try failed.
      if (gen === loadGenRef.current) setOlderError(errorMessage(err, 'Failed to load older messages'))
      return []
    } finally {
      if (gen === loadGenRef.current) setLoadingOlder(false)
    }
  }, [recipientAddress, identity, token, loadingOlder, hasMore, decryptAll, openPending, rerender])

  const prependMessages = useCallback((fresh: DecryptedMessage[]) => {
    if (fresh.length === 0) return
    storeRef.current.unstage()
    rerender()
  }, [rerender])

  // Reset per-conversation view state; the store was already replaced.
  useEffect(() => {
    cursorRef.current = null
    setRecipientPubkey(null)
    setHasMore(false)
    setLoadingOlder(false)
    setError(null)
    setOlderError(null)
  }, [recipientAddress])

  useEffect(() => {
    loadMessages()
  }, [loadMessages])

  // A (re)opened stream starts a refresh; losing it already hid content
  // with changeable deadlines during render.
  useEffect(() => {
    if (connected && loadedRef.current) void synchronize()
    else rerender()
  }, [connected, synchronize, rerender])

  // Regaining attention re-checks expiry (background timers can run late),
  // reveals confirmations that landed meanwhile and opens what arrived.
  const attentive = useWindowAttention()
  useEffect(() => {
    if (!attentive) return
    storeRef.current.sweep(Date.now(), { synchronized: synchronizedRef.current })
    rerender()
    void openPending()
  }, [attentive, openPending, rerender])

  // One timer for the earliest upcoming deadline, recomputed after every
  // render so changed deadlines replace it.
  useEffect(() => {
    const store = storeRef.current
    const next = store.nextDeadline(Date.now())
    if (next === null) return
    const timer = setTimeout(() => {
      store.sweep(Date.now(), { synchronized: synchronizedRef.current })
      rerender()
    }, Math.min(next - Date.now(), MAX_TIMER_MS))
    return () => clearTimeout(timer)
  })

  // Only confirmed openings (and your own messages) clear unread state;
  // selecting the conversation alone does not.
  useEffect(() => {
    const seen = storeRef.current.seenThrough()
    if (recipientAddress && seen !== null) markConversationSeen(recipientAddress, seen)
  })

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
    } catch (err) {
      throw new Error(errorMessage(err, 'Server rejected the message'))
    }
  }

  const addMessage = useCallback(async (input: unknown) => {
    const gen = loadGenRef.current
    const decrypted = await decryptMessage(input)
    if (!decrypted || gen !== loadGenRef.current) return
    storeRef.current.add([decrypted])
    rerender()
    void openPending()
  }, [decryptMessage, openPending, rerender])

  // Failed IDs stay hidden; retrying never revives what the server reported
  // unavailable, because those were removed.
  const retryOpening = useCallback(() => {
    storeRef.current.retryFailed()
    rerender()
    void openPending()
  }, [openPending, rerender])

  // The stream carries expiry updates for every conversation; only this
  // one's apply, and the store only lets lifecycles move forward.
  const applyExpiryUpdate = useCallback((input: unknown) => {
    const update = parseExpiryUpdate(input)
    if (!update || !identity || !recipientAddress
      || !isEnvelopeParticipant(update, identity.address, recipientAddress)) return
    storeRef.current.applyLifecycle(update.id, update)
    rerender()
  }, [identity, recipientAddress, rerender])

  // A failed initial load retries the load; after that, a failed refresh
  // retries synchronization without discarding loaded history.
  const retry = useCallback(() => {
    if (loadedRef.current) void synchronize()
    else void loadMessages()
  }, [loadMessages, synchronize])

  const messages = storeRef.current.display(Date.now(), {
    eligible: recipientAddress !== null && attentive,
    synchronized: synchronizedRef.current,
  })
  const openingFailed = storeRef.current.hasFailedOpenings()

  return { messages, loading, error, olderError, hasMore, loadingOlder, fetchOlder, prependMessages, sendMessage, recipientPubkey, addMessage, applyExpiryUpdate, refresh: retry, openingFailed, retryOpening }
}
