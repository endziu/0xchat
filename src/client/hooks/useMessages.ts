import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { api, type RecoveryPage } from '../lib/api'
import type { ConversationRefreshResult } from './useConversations'
import type { ConnectionEpoch, LiveConnection } from './useSSE'
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

interface MessageWork {
  generation: number
  connectionEpoch: ConnectionEpoch | null
  attentionEpoch: number
}

function sameWork(left: MessageWork | null, right: MessageWork): boolean {
  return left?.generation === right.generation && left.connectionEpoch === right.connectionEpoch
    && left.attentionEpoch === right.attentionEpoch
}

/** Drain a bounded recovery interval, checking validity at each async boundary. */
async function recoverInterval(
  page: RecoveryPage,
  fetchNext: (cursor: string) => Promise<RecoveryPage>,
  decryptPage: (messages: unknown[]) => Promise<DecryptedMessage[]>,
  store: ConversationMessages,
  current: () => boolean,
): Promise<string | null> {
  const continuations = new Set<string>()
  for (;;) {
    if (!Array.isArray(page.messages) || typeof page.exhausted !== 'boolean') throw new Error('Invalid recovery response')
    const decrypted = await decryptPage(page.messages)
    if (!current()) return null
    store.add(decrypted)
    if (page.exhausted) return page.recovery_cursor
    if (!page.next_cursor || continuations.has(page.next_cursor)) throw new Error('Invalid recovery continuation')
    continuations.add(page.next_cursor)
    page = await fetchNext(page.next_cursor)
    if (!current()) return null
  }
}

/**
 * Messages of the selected conversation. `connected` is the live stream's
 * state: loaded lifecycle state is synchronized only after a complete state
 * refresh establishes authoritative deadlines and server time on the current
 * connection. An open transport alone is not enough.
 */
export function useMessages(recipientAddress: string | null, identity: Keypair | null, token: string | null, connected: boolean, connection: LiveConnection, refreshConversations: () => Promise<ConversationRefreshResult>) {
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
  const synchronizedConnection = useRef<ConnectionEpoch | null>(null)
  const recoveryCursor = useRef<string | null>(null)
  const finalVisibleIds = useRef(new Set<string>())
  const buffered = useRef<Array<{ type: 'message' | 'expiry'; data: unknown }>>([])
  const attentive = useWindowAttention()
  const previousAttention = useRef(attentive)
  const attentionEpoch = useRef(0)
  if (previousAttention.current !== attentive) {
    previousAttention.current = attentive
    attentionEpoch.current++
    synchronizedRef.current = false
    storeRef.current.cancelOpening()
  }
  const isSynchronized = () => synchronizedRef.current && connection.current !== null
    && synchronizedConnection.current === connection.current && isWindowAttentive()
  if (scopeRef.current !== scope) {
    scopeRef.current = scope
    storeRef.current = new ConversationMessages(identity?.address ?? '')
    loadGenRef.current++
    loadedRef.current = false
    synchronizedRef.current = false
    synchronizedConnection.current = null
    recoveryCursor.current = null
    finalVisibleIds.current.clear()
    buffered.current = []
  }
  // Each change of connection state starts a new epoch; losing the stream
  // ends synchronization and invalidates refreshes begun before.
  const previousConnection = useRef(connection.current)
  if (previousConnection.current !== connection.current) {
    previousConnection.current = connection.current
    synchronizedRef.current = false
    storeRef.current.cancelOpening()
  }
  // Server-issued cursor for the next older page. (created_at, rowid) is a
  // total order — timestamps alone are ambiguous (Date.now() millisecond
  // ties) — and it stays valid after the page's messages expire.
  const cursorRef = useRef<{ before: number; rowid: number | null } | null>(null)

  const captureWork = (): MessageWork => ({ generation: loadGenRef.current, connectionEpoch: connection.current, attentionEpoch: attentionEpoch.current })
  const isCurrentWork = (work: MessageWork) => sameWork(work, captureWork())
  const bufferUntilSynchronized = (type: 'message' | 'expiry', data: unknown): boolean => {
    if (isSynchronized()) return false
    buffered.current.push({ type, data })
    return true
  }

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
  const openingQueueRef = useRef<{ work: MessageWork | null; queue: Promise<void> }>({ work: null, queue: Promise.resolve() })
  const openPending = useCallback((): Promise<void> => {
    const work = captureWork()
    const run = async (): Promise<void> => {
      if (!isCurrentWork(work) || !recipientAddress || !token || !isSynchronized()) return
      const store = storeRef.current
      const ids = store.takePending()
      if (ids.length === 0) return
      await Promise.all(batches(ids, ID_BATCH).map(async batch => {
        let response: unknown
        const requestStarted = performance.now()
        try {
          response = await api.openMessages(recipientAddress, batch, token)
        } catch (err) {
          console.error('Failed to open messages:', err)
          if (isCurrentWork(work)) store.failOpening(batch)
          return
        }
        if (isCurrentWork(work) && isSynchronized()) store.confirmOpening(batch, response, requestStarted)
      }))
      if (isCurrentWork(work)) rerender()
    }
    // A new conversation, identity or session never waits behind the
    // previous one's requests.
    const previous = sameWork(openingQueueRef.current.work, work) ? openingQueueRef.current.queue : Promise.resolve()
    const queued = previous.then(run, run)
    openingQueueRef.current = { work, queue: queued }
    return queued
  }, [recipientAddress, token, rerender])

  // Applies buffered live events in arrival order, including events arriving
  // during decryption. False when the work was superseded partway.
  const drainBuffered = useCallback(async (current: () => boolean): Promise<boolean> => {
    if (!recipientAddress || !identity || !token) return false
    const store = storeRef.current
    while (buffered.current.length || (!store.hasServerTime() && store.ids().length)) {
      const events = buffered.current.splice(0)
      for (const event of events) {
        if (event.type === 'message') {
          const message = await decryptMessage(event.data)
          if (!current()) return false
          if (message) store.add([message])
        } else {
          const update = parseExpiryUpdate(event.data)
          if (update && isEnvelopeParticipant(update, identity.address, recipientAddress)) store.applyLifecycle(update.id, update)
        }
      }
      if (!store.hasServerTime() && store.ids().length) {
        const ids = store.ids().slice(0, ID_BATCH)
        const started = performance.now()
        const response = await api.getMessageStates(recipientAddress, ids, token)
        if (!current()) return false
        if (!store.applyStates(ids, response, started)) throw new Error('Invalid message state response')
      }
    }
    return current()
  }, [recipientAddress, identity, token, decryptMessage])

  // Refreshes every loaded message's lifecycle once the stream is open. Only
  // a complete refresh on the current connection restores content whose
  // deadline could have changed meanwhile, such as an unopened sender copy.
  const syncingRef = useRef<MessageWork | null>(null)
  const synchronize = useCallback(async (): Promise<void> => {
    if (!recipientAddress || !identity || !token || !connection.current || isSynchronized()) return
    const attempt = captureWork()
    if (sameWork(syncingRef.current, attempt)) return
    syncingRef.current = attempt
    const current = () => isCurrentWork(attempt) && isWindowAttentive()
    const store = storeRef.current
    setLoading(!loadedRef.current)
    try {
      // Capture the interval upper bound (or initial snapshot) only after SSE
      // is listening. Events stay buffered until every recovery page completes.
      const checkpoint = recoveryCursor.current
      const initial = checkpoint === null
        ? await api.getMessages(recipientAddress, token, undefined, undefined, PAGE_SIZE) : null
      const page = checkpoint === null ? null : await api.recoverMessages(recipientAddress, token, { after: checkpoint })
      if (!current()) return
      if (await refreshConversations() !== 'refreshed') throw new Error('Failed to refresh conversations')
      if (!current()) return
      let completed: string | null = null
      if (initial) {
        const decrypted = await decryptAll(initial.messages)
        if (!current()) return
        store.add(decrypted.reverse())
        if (!loadedRef.current) {
          cursorRef.current = initial.next_before != null ? { before: initial.next_before, rowid: initial.next_before_rowid } : null
          setHasMore(initial.messages.length === PAGE_SIZE)
        }
        // This initial page defines the baseline, even if the subsequent
        // lifecycle refresh fails. Retry must recover from it, never replace
        // it with a newer initial page that could skip intervening messages.
        completed = initial.recovery_cursor
        recoveryCursor.current = completed
        loadedRef.current = true
      }
      if (page) {
        completed = await recoverInterval(page,
          cursor => api.recoverMessages(recipientAddress, token, { cursor }), decryptAll, store, current)
        if (!current()) return
      }
      if (typeof completed !== 'string' || !completed) throw new Error('Missing recovery checkpoint')
      loadedRef.current = true
      // Messages that land while a round is in flight, such as an older page
      // requested before reconnecting, are looked up in the next round.
      const refreshed = new Set<string>()
      for (let round = 0; round < MAX_REFRESH_ROUNDS; round++) {
        const ids = store.ids().filter(id => !refreshed.has(id))
        if (ids.length === 0 && round > 0) break
        const responses = await Promise.all(batches(ids, ID_BATCH).map(async batch => {
          const requestStarted = performance.now()
          return { batch, requestStarted, response: await api.getMessageStates(recipientAddress, batch, token) }
        }))
        if (!current()) return
        const complete = responses.map(({ batch, response, requestStarted }) => store.applyStates(batch, response, requestStarted)).every(Boolean)
        if (!complete) throw new Error('Invalid message state response')
        for (const id of ids) refreshed.add(id)
      }
      if (store.ids().some(id => !refreshed.has(id))) throw new Error('Messages changed during refresh; retry to synchronize')
      if (!await drainBuffered(current)) return
      recoveryCursor.current = completed
      store.unstage()
      synchronizedConnection.current = attempt.connectionEpoch
      synchronizedRef.current = true
      store.sweep(store.now(), { synchronized: true })
      setError(null)
      rerender()
      void openPending()
    } catch (err) {
      console.error('Failed to refresh messages:', err)
      if (current()) setError(errorMessage(err, 'Failed to refresh messages'))
    } finally {
      if (syncingRef.current === attempt) syncingRef.current = null
      if (current()) setLoading(false)
    }
  }, [recipientAddress, identity, token, decryptAll, drainBuffered, refreshConversations, openPending, rerender])

  // Regaining focus on the stream that was synchronized before blur needs no
  // refresh: it stayed live, so every change since is in the buffer. Focus
  // flips constantly on focus-follows-pointer desktops, so this path must not
  // cost a request. Any interruption falls back to a full synchronize.
  const resume = useCallback(async (): Promise<void> => {
    if (!connection.current || synchronizedConnection.current !== connection.current) return synchronize()
    if (isSynchronized()) return
    const attempt = captureWork()
    if (sameWork(syncingRef.current, attempt)) return
    syncingRef.current = attempt
    const current = () => isCurrentWork(attempt) && isWindowAttentive()
    try {
      if (!await drainBuffered(current)) {
        // Events taken from the buffer may be lost; only recovery restores them.
        synchronizedConnection.current = null
        return
      }
      synchronizedRef.current = true
      storeRef.current.sweep(storeRef.current.now(), { synchronized: true })
      rerender()
      void openPending()
    } catch (err) {
      console.error('Failed to resume messages:', err)
      synchronizedConnection.current = null
      if (current()) void synchronize()
    } finally {
      if (syncingRef.current === attempt) syncingRef.current = null
    }
  }, [drainBuffered, synchronize, openPending, rerender])

  const loadMessages = useCallback(async () => {
    if (!recipientAddress || !identity || !token) {
      setRecipientPubkey(null)
      setHasMore(false)
      setError(null)
      setOlderError(null)
      return
    }

    const gen = loadGenRef.current
    setLoading(true)
    setError(null)
    setOlderError(null)
    try {
      const { pubkey } = await api.getPubkey(recipientAddress)
      if (gen !== loadGenRef.current) return
      setRecipientPubkey(pubkey)

      await synchronize()
    } catch (err) {
      console.error('Failed to load messages:', err)
      if (gen === loadGenRef.current) setError(errorMessage(err, 'Failed to load messages'))
    } finally {
      if (gen === loadGenRef.current) setLoading(false)
    }
  }, [recipientAddress, identity, token, decryptAll, openPending, synchronize, rerender])

  // The pane captures its anchor before this request; normal rendering can
  // prepend available content as each opening is confirmed.
  const fetchOlder = useCallback(async (): Promise<void> => {
    if (!recipientAddress || !identity || !token || !isSynchronized() || loadingOlder || !hasMore) return
    const cursor = cursorRef.current
    if (!cursor) return

    const work = captureWork()
    const gen = work.generation
    const store = storeRef.current
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const page = await api.getMessages(recipientAddress, token, cursor.before, cursor.rowid ?? undefined, PAGE_SIZE)
      if (!isCurrentWork(work)) return
      const decrypted = await decryptAll(page.messages)
      if (!isCurrentWork(work)) return
      cursorRef.current = page.next_before != null ? { before: page.next_before, rowid: page.next_before_rowid } : null
      setHasMore(page.messages.length === PAGE_SIZE)
      store.add(decrypted.reverse())
      rerender()
      void openPending()
    } catch (err) {
      console.error('Failed to load older messages:', err)
      // The cursor only advances on success, so the load-older button is
      // still the retry — it just needs to say that the last try failed.
      if (gen === loadGenRef.current) setOlderError(errorMessage(err, 'Failed to load older messages'))
      return
    } finally {
      if (gen === loadGenRef.current) setLoadingOlder(false)
    }
  }, [recipientAddress, identity, token, loadingOlder, hasMore, decryptAll, openPending, rerender])

  useEffect(() => () => { loadGenRef.current++ }, [])

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
    if (connected) void synchronize()
    else rerender()
  }, [connected, connection.current, synchronize, rerender])

  // Regaining attention re-checks expiry (background timers can run late),
  // reveals confirmations that landed meanwhile and opens what arrived.
  useEffect(() => {
    if (!attentive) return
    storeRef.current.sweep(storeRef.current.now(), { synchronized: isSynchronized() })
    rerender()
    void resume()
  }, [attentive, resume, rerender])

  // One timer for the earliest upcoming deadline, recomputed after every
  // render so changed deadlines replace it. Capture it during render: the
  // deadline may pass before the effect runs, in which case schedule now.
  const nextExpiry = storeRef.current.nextDeadline(storeRef.current.now())
  useEffect(() => {
    const store = storeRef.current
    const next = nextExpiry
    if (next === null) return
    const timer = setTimeout(() => {
      store.sweep(store.now(), { synchronized: isSynchronized() })
      rerender()
    }, Math.max(0, Math.min(Math.ceil(next - store.now()), MAX_TIMER_MS)))
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
    if (bufferUntilSynchronized('message', input)) return
    const work = captureWork()
    const decrypted = await decryptMessage(input)
    if (!decrypted || !isCurrentWork(work) || !isSynchronized()) return
    storeRef.current.add([decrypted])
    if (!storeRef.current.hasServerTime()) {
      synchronizedRef.current = false
      void synchronize()
    }
    rerender()
    void openPending()
  }, [decryptMessage, openPending, synchronize, rerender])

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
    if (bufferUntilSynchronized('expiry', input)) return
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

  const displayed = storeRef.current.display(storeRef.current.now(), {
    eligible: recipientAddress !== null && attentive,
    synchronized: isSynchronized(),
  })
  const messages = isSynchronized() ? displayed : displayed.filter(message => finalVisibleIds.current.has(message.id))
  if (isSynchronized()) finalVisibleIds.current = new Set(messages
    .filter(message => message.delivery_policy === 'legacy' || message.opened_at !== null).map(message => message.id))
  const openingFailed = storeRef.current.hasFailedOpenings()

  return { messages, recovering: !isSynchronized(), loading, error, olderError, hasMore, loadingOlder, fetchOlder, sendMessage, recipientPubkey, addMessage, applyExpiryUpdate, refresh: retry, openingFailed, retryOpening }
}
