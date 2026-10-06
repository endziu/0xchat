import type { Address } from '../../shared/address'
import { ConversationMessages, type DecryptedMessage } from './conversation-messages'
import { errorMessage } from './errors'
import type { MessagePage, RecoveryPage } from './api'
import type { ConnectionEpoch } from './sse-connection'
import { isEnvelopeParticipant, type DeliveredMessage, type ExpiryUpdate } from '../../shared/message-envelope'
import type { LiveEvent } from '../../shared/live-events'

const PAGE_SIZE = 50
// The opening and state endpoints accept at most 100 IDs per request.
const ID_BATCH = 100
// A refresh repeats for messages loaded while it was in flight, a bounded
// number of times.
const MAX_REFRESH_ROUNDS = 3
// setTimeout overflows above 2^31 - 1 ms.
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Server-issued cursor for the next older page: the oldest returned message's
 * acceptance sequence, which stays valid after that message expires.
 */
export type HistoryCursor = number

/** The server, as one identity's session sees one conversation. */
export interface ConversationProtocol {
  /** The conversation partner's encryption public key; null while unregistered. */
  partnerPubkey(): Promise<string | null>
  /** The newest history page, or the page before `before`. */
  history(limit: number, before?: HistoryCursor): Promise<MessagePage>
  recover(cursor: { after: string } | { cursor: string }): Promise<RecoveryPage>
  /** Lifecycle state lookup, which never opens. The response is unvalidated server input. */
  states(ids: string[]): Promise<unknown>
  /** Message opening, which starts lifetimes. The response is unvalidated server input. */
  open(ids: string[]): Promise<unknown>
  clear(): Promise<{ cleared_at: number }>
  /** Refreshes the conversation list; false when that failed. */
  refreshConversations(): Promise<boolean>
  /** Encrypts and signs a message to the partner's public key, then sends it. */
  send(plaintext: string, ttl: number, partnerPubkey: string): Promise<DeliveredMessage>
}

export interface SessionClock {
  /** Monotonic milliseconds, as `performance.now()`. */
  now(): number
  /** Calls `callback` after `delay` ms; returns a function that cancels it. */
  setTimer(callback: () => void, delay: number): () => void
}

export const systemClock: SessionClock = {
  now: () => performance.now(),
  setTimer: (callback, delay) => {
    const timer = setTimeout(callback, delay)
    return () => clearTimeout(timer)
  },
}

export interface SessionOptions {
  /** The identity's address. */
  self: Address
  /** The conversation partner's address. */
  partner: Address
  protocol: ConversationProtocol
  /** Verifies and decrypts a delivered message of this conversation; null for anything else. */
  decrypt: (input: unknown) => Promise<DecryptedMessage | null>
  clock?: SessionClock
  /** The live stream's current epoch, or null while it is down. */
  connection: ConnectionEpoch | null
  /** The conversation is selected in a visible, focused window. */
  attentive: boolean
}

export interface SessionSnapshot {
  messages: DecryptedMessage[]
  /** Server time once known: the clock expiry runs on, for showing time left. */
  now: () => number
  /** Loaded lifecycle state is not authoritative on the current connection. */
  recovering: boolean
  loading: boolean
  error: string | null
  olderError: string | null
  hasMore: boolean
  loadingOlder: boolean
  /** Incoming messages whose opening was not confirmed stay hidden until retryOpening(). */
  openingFailed: boolean
  recipientPubkey: string | null
  /** The newest acceptance time through which the conversation counts as seen. */
  seenThrough: number | null
}

type ViewState = Pick<SessionSnapshot, 'loading' | 'error' | 'olderError' | 'hasMore' | 'loadingOlder' | 'recipientPubkey'>

// Live events held until the view is synchronized, in arrival order.
type BufferedEvent = Extract<LiveEvent, { type: 'message' | 'expiry-update' }>

// A connection epoch and attention state. Changing either starts new work,
// which supersedes everything begun before.
interface Work {
  readonly connection: ConnectionEpoch | null
  readonly attentive: boolean
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

/**
 * The selected conversation's messages for one identity, conversation
 * partner and session token. Loaded lifecycle state is synchronized only
 * after a complete state refresh establishes authoritative deadlines and
 * server time on the current connection while the window is attentive. An
 * open transport alone is not enough.
 */
export class ConversationSession {
  private readonly self: Address
  private readonly partner: Address
  private readonly protocol: ConversationProtocol
  private readonly decrypt: (input: unknown) => Promise<DecryptedMessage | null>
  private readonly clock: SessionClock
  private readonly store: ConversationMessages
  private readonly listeners = new Set<() => void>()
  private work: Work
  // The work on which loaded state last became authoritative. The view is
  // synchronized only while that is still the current work; later work on
  // the same connection can resume from it without a request.
  private synchronizedWork: Work | null = null
  private syncing: Work | null = null
  private disposed = false
  private loaded = false
  private recoveryCursor: string | null = null
  private olderCursor: HistoryCursor | null = null
  private buffered: BufferedEvent[] = []
  private openingQueue: { work: Work; queue: Promise<void> }
  // Shown with a final deadline while synchronized, so still shown out of sync.
  private finalVisibleIds = new Set<string>()
  private cancelTimer: (() => void) | null = null
  private view: ViewState = {
    loading: false, error: null, olderError: null, hasMore: false, loadingOlder: false, recipientPubkey: null,
  }
  private current: SessionSnapshot
  private readonly now = () => this.store.now()

  constructor({ self, partner, protocol, decrypt, clock = systemClock, connection, attentive }: SessionOptions) {
    this.self = self
    this.partner = partner
    this.protocol = protocol
    this.decrypt = decrypt
    this.clock = clock
    this.store = new ConversationMessages(self, () => clock.now())
    this.work = { connection, attentive }
    this.openingQueue = { work: this.work, queue: Promise.resolve() }
    this.current = this.compute()
    void this.load()
  }

  snapshot(): SessionSnapshot {
    return this.current
  }

  /** Calls `listener` after every snapshot change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Ends the session: in-flight work is ignored and listeners hear nothing more. */
  dispose(): void {
    this.disposed = true
    this.work = { connection: null, attentive: false }
    this.cancelTimer?.()
    this.listeners.clear()
  }

  /** Each change of connection state starts new work; a (re)opened stream starts a refresh. */
  connectionChanged(connection: ConnectionEpoch | null): void {
    if (this.disposed || connection === this.work.connection) return
    this.startWork({ connection, attentive: this.work.attentive })
    this.publish()
    void this.synchronize()
  }

  attentionChanged(attentive: boolean): void {
    if (this.disposed || attentive === this.work.attentive) return
    this.startWork({ connection: this.work.connection, attentive })
    // Regaining attention re-checks expiry (background timers can run late),
    // reveals confirmations that landed meanwhile and opens what arrived.
    if (attentive) this.store.sweep(this.store.now(), { synchronized: this.synchronized })
    this.publish()
    if (attentive) void this.resume()
  }

  liveEvent(event: LiveEvent): void {
    if (this.disposed) return
    switch (event.type) {
      case 'message':
        void this.receive(event.data)
        return
      case 'expiry-update':
        this.applyExpiryUpdate(event.data)
        return
      // Clearing is a removal, so it applies whether or not the view is
      // synchronized; the store also rejects cleared messages that load later.
      case 'conversation-cleared':
        if (event.data.address !== this.partner) return
        this.store.clear(event.data.cleared_at)
        this.publish()
        return
      case 'user:disconnected':
        return
      default:
        return event satisfies never
    }
  }

  // The pane captures its anchor before this request; normal rendering can
  // prepend available content as each opening is confirmed.
  async fetchOlder(): Promise<void> {
    if (!this.synchronized || this.view.loadingOlder || !this.view.hasMore) return
    const cursor = this.olderCursor
    if (cursor === null) return

    const work = this.work
    this.view.loadingOlder = true
    this.view.olderError = null
    this.publish()
    try {
      const page = await this.protocol.history(PAGE_SIZE, cursor)
      if (work !== this.work) return
      const decrypted = await this.decryptAll(page.messages)
      if (work !== this.work) return
      this.olderCursor = page.next_before_seq
      this.view.hasMore = page.messages.length === PAGE_SIZE
      this.store.add(decrypted.reverse())
      void this.openPending()
    } catch (err) {
      console.error('Failed to load older messages:', err)
      // The cursor only advances on success, so the load-older button is
      // still the retry — it just needs to say that the last try failed.
      if (!this.disposed) this.view.olderError = errorMessage(err, 'Failed to load older messages')
    } finally {
      if (!this.disposed) {
        this.view.loadingOlder = false
        this.publish()
      }
    }
  }

  // A failed initial load retries the load; after that, a failed refresh
  // retries synchronization without discarding loaded history.
  retry(): void {
    if (this.loaded) void this.synchronize()
    else void this.load()
  }

  // Failed IDs stay hidden; retrying never revives what the server reported
  // unavailable, because those were removed.
  retryOpening(): void {
    this.store.retryFailed()
    this.publish()
    void this.openPending()
  }

  /** Deletes every message in this conversation for both participants; returns the clear time. */
  async clear(): Promise<number> {
    const { cleared_at } = await this.protocol.clear()
    // A late response reaches only this session, never another conversation's.
    if (!this.disposed) {
      this.store.clear(cleared_at)
      this.publish()
    }
    return cleared_at
  }

  async send(plaintext: string, ttl: number): Promise<DeliveredMessage> {
    const pubkey = this.view.recipientPubkey
    if (!pubkey) throw new Error('Recipient has not registered their encryption key yet')
    return this.protocol.send(plaintext, ttl, pubkey)
  }

  private get synchronized(): boolean {
    return this.synchronizedWork === this.work
  }

  private startWork(work: Work): void {
    this.work = work
    this.store.cancelOpening()
  }

  private compute(): SessionSnapshot {
    const synchronized = this.synchronized
    const displayed = this.store.display(this.store.now(), { eligible: this.work.attentive, synchronized })
    const messages = synchronized ? displayed : displayed.filter(message => this.finalVisibleIds.has(message.id))
    if (synchronized) this.finalVisibleIds = new Set(messages.filter(message => message.opened_at !== null).map(message => message.id))
    return {
      messages,
      now: this.now,
      recovering: !synchronized,
      ...this.view,
      openingFailed: this.store.hasFailedOpenings(),
      seenThrough: this.store.seenThrough(),
    }
  }

  // Recomputes the snapshot, then keeps one timer for the earliest upcoming
  // deadline so changed deadlines replace it.
  private publish(): void {
    if (this.disposed) return
    this.current = this.compute()
    this.cancelTimer?.()
    this.cancelTimer = null
    const now = this.store.now()
    const next = this.store.nextDeadline(now)
    if (next !== null) {
      this.cancelTimer = this.clock.setTimer(() => {
        this.store.sweep(this.store.now(), { synchronized: this.synchronized })
        this.publish()
      }, Math.max(0, Math.min(Math.ceil(next - now), MAX_TIMER_MS)))
    }
    for (const listener of this.listeners) listener()
  }

  // Loads the partner's key while the first synchronization runs.
  private async load(): Promise<void> {
    this.view.loading = true
    this.view.error = null
    this.view.olderError = null
    this.publish()
    const synchronized = this.synchronize()
    try {
      const pubkey = await this.protocol.partnerPubkey()
      if (this.disposed) return
      this.view.recipientPubkey = pubkey
      this.publish()
      await synchronized
    } catch (err) {
      console.error('Failed to load messages:', err)
      if (!this.disposed) this.view.error = errorMessage(err, 'Failed to load messages')
    } finally {
      if (!this.disposed) {
        this.view.loading = false
        this.publish()
      }
    }
  }

  private async decryptAll(inputs: unknown[]): Promise<DecryptedMessage[]> {
    return (await Promise.all(inputs.map(input => this.decrypt(input)))).filter((message): message is DecryptedMessage => message !== null)
  }

  // Requests opening for every pending incoming message, but only while the
  // conversation is attentive and synchronized — checked as each request is
  // made, after any decryption. Plaintext stays hidden until the server
  // confirms each ID. Requests run one after another, so messages arriving
  // during one share the next instead of each spending the opening budget.
  private openPending(): Promise<void> {
    const work = this.work
    const run = async (): Promise<void> => {
      if (work !== this.work || !this.synchronized) return
      const store = this.store
      const ids = store.takePending()
      if (ids.length === 0) return
      await Promise.all(batches(ids, ID_BATCH).map(async batch => {
        let response: unknown
        const requestStarted = this.clock.now()
        try {
          response = await this.protocol.open(batch)
        } catch (err) {
          console.error('Failed to open messages:', err)
          if (work === this.work) store.failOpening(batch)
          return
        }
        if (work === this.work && this.synchronized) store.confirmOpening(batch, response, requestStarted)
      }))
      if (work === this.work) this.publish()
    }
    // New work never waits behind superseded requests.
    const previous = this.openingQueue.work === work ? this.openingQueue.queue : Promise.resolve()
    const queued = previous.then(run, run)
    this.openingQueue = { work, queue: queued }
    return queued
  }

  /** Drains a bounded recovery interval, checking validity at each async boundary. */
  private async recoverInterval(page: RecoveryPage, current: () => boolean): Promise<string | null> {
    const continuations = new Set<string>()
    for (;;) {
      if (!Array.isArray(page.messages) || typeof page.exhausted !== 'boolean') throw new Error('Invalid recovery response')
      const decrypted = await this.decryptAll(page.messages)
      if (!current()) return null
      this.store.add(decrypted)
      if (page.exhausted) return page.recovery_cursor
      if (!page.next_cursor || continuations.has(page.next_cursor)) throw new Error('Invalid recovery continuation')
      continuations.add(page.next_cursor)
      page = await this.protocol.recover({ cursor: page.next_cursor })
      if (!current()) return null
    }
  }

  // Applies buffered live events in arrival order, including events arriving
  // during decryption. Each leaves the buffer only once applied, so work
  // superseded partway leaves the rest to the current work. False when
  // superseded.
  private async drainBuffered(current: () => boolean): Promise<boolean> {
    const store = this.store
    while (this.buffered.length || (!store.hasServerTime() && store.ids().length)) {
      for (let event = this.buffered[0]; event; event = this.buffered[0]) {
        if (event.type === 'message') {
          const message = await this.decrypt(event.data)
          if (!current()) return false
          if (message) store.add([message])
        } else if (isEnvelopeParticipant(event.data, this.self, this.partner)) {
          store.applyLifecycle(event.data.id, event.data)
        }
        this.buffered.shift()
      }
      if (!store.hasServerTime() && store.ids().length) {
        const ids = store.ids().slice(0, ID_BATCH)
        const started = this.clock.now()
        const response = await this.protocol.states(ids)
        if (!current()) return false
        if (!store.applyStates(ids, response, started)) throw new Error('Invalid message state response')
      }
    }
    return current()
  }

  // Refreshes every loaded message's lifecycle once the stream is open and
  // the window attentive. Only a complete refresh on the current connection
  // restores content whose deadline could have changed meanwhile, such as an
  // unopened sender copy.
  private async synchronize(): Promise<void> {
    const attempt = this.work
    if (!attempt.connection || !attempt.attentive || this.synchronized || this.syncing === attempt) return
    this.syncing = attempt
    const current = () => attempt === this.work
    const store = this.store
    if (!this.loaded) {
      this.view.loading = true
      this.publish()
    }
    try {
      // Capture the interval upper bound (or initial snapshot) only after SSE
      // is listening. Events stay buffered until every recovery page completes.
      const checkpoint = this.recoveryCursor
      const initial = checkpoint === null ? await this.protocol.history(PAGE_SIZE) : null
      const page = checkpoint === null ? null : await this.protocol.recover({ after: checkpoint })
      if (!current()) return
      if (!await this.protocol.refreshConversations()) throw new Error('Failed to refresh conversations')
      if (!current()) return
      let completed: string | null = null
      if (initial) {
        const decrypted = await this.decryptAll(initial.messages)
        if (!current()) return
        store.add(decrypted.reverse())
        if (!this.loaded) {
          this.olderCursor = initial.next_before_seq
          this.view.hasMore = initial.messages.length === PAGE_SIZE
        }
        // This initial page defines the baseline, even if the subsequent
        // lifecycle refresh fails. Retry must recover from it, never replace
        // it with a newer initial page that could skip intervening messages.
        completed = initial.recovery_cursor
        this.recoveryCursor = completed
        this.loaded = true
      }
      if (page) {
        completed = await this.recoverInterval(page, current)
        if (!current()) return
      }
      if (typeof completed !== 'string' || !completed) throw new Error('Missing recovery checkpoint')
      this.loaded = true
      // Messages that land while a round is in flight, such as an older page
      // requested before reconnecting, are looked up in the next round.
      const refreshed = new Set<string>()
      for (let round = 0; round < MAX_REFRESH_ROUNDS; round++) {
        const ids = store.ids().filter(id => !refreshed.has(id))
        if (ids.length === 0 && round > 0) break
        const responses = await Promise.all(batches(ids, ID_BATCH).map(async batch => {
          const requestStarted = this.clock.now()
          return { batch, requestStarted, response: await this.protocol.states(batch) }
        }))
        if (!current()) return
        const complete = responses.map(({ batch, response, requestStarted }) => store.applyStates(batch, response, requestStarted)).every(Boolean)
        if (!complete) throw new Error('Invalid message state response')
        for (const id of ids) refreshed.add(id)
      }
      if (store.ids().some(id => !refreshed.has(id))) throw new Error('Messages changed during refresh; retry to synchronize')
      if (!await this.drainBuffered(current)) return
      this.recoveryCursor = completed
      this.synchronizedWork = attempt
      store.sweep(store.now(), { synchronized: true })
      this.view.error = null
      void this.openPending()
    } catch (err) {
      console.error('Failed to refresh messages:', err)
      if (current()) this.view.error = errorMessage(err, 'Failed to refresh messages')
    } finally {
      if (this.syncing === attempt) this.syncing = null
      if (current()) {
        this.view.loading = false
        this.publish()
      }
    }
  }

  // Regaining attention on the stream that was synchronized before needs no
  // refresh: it stayed live, so every change since is in the buffer. Focus
  // flips constantly on focus-follows-pointer desktops, so this path must not
  // cost a request. Any interruption falls back to a full synchronize.
  private async resume(): Promise<void> {
    const attempt = this.work
    if (!attempt.connection || this.synchronizedWork?.connection !== attempt.connection) return this.synchronize()
    if (this.synchronized || this.syncing === attempt) return
    this.syncing = attempt
    const current = () => attempt === this.work
    let failed = false
    try {
      if (!await this.drainBuffered(current)) return
      this.synchronizedWork = attempt
      this.store.sweep(this.store.now(), { synchronized: true })
      this.publish()
      void this.openPending()
    } catch (err) {
      console.error('Failed to resume messages:', err)
      failed = true
    } finally {
      if (this.syncing === attempt) this.syncing = null
    }
    if (failed && current()) await this.synchronize()
  }

  private async receive(input: DeliveredMessage): Promise<void> {
    if (!this.synchronized) {
      this.buffered.push({ type: 'message', data: input })
      return
    }
    const work = this.work
    const message = await this.decrypt(input)
    if (!message || work !== this.work || !this.synchronized) return
    this.store.add([message])
    if (!this.store.hasServerTime()) {
      this.synchronizedWork = null
      void this.synchronize()
    }
    this.publish()
    void this.openPending()
  }

  // The stream carries expiry updates for every conversation; only this
  // one's apply, and the store only lets lifecycles move forward.
  private applyExpiryUpdate(update: ExpiryUpdate): void {
    if (!this.synchronized) {
      this.buffered.push({ type: 'expiry-update', data: update })
      return
    }
    if (!isEnvelopeParticipant(update, this.self, this.partner)) return
    this.store.applyLifecycle(update.id, update)
    this.publish()
  }
}
