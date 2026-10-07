import type { Address } from '../../shared/address'
import { parseDeliveryLifecycle, type MessageLifecycle } from '../../shared/message-envelope'
import { confirmMessage, type ConfirmationResponse, type DecryptedMessage } from '../../shared/protocol-client'

// Incoming messages move pending → requested → confirmed; a failed request
// parks them as failed until an explicit retry. Sender copies never open.
type Opening = 'pending' | 'requested' | 'failed' | 'confirmed'

interface Entry {
  message: DecryptedMessage
  opening: Opening | null
  // Shown at least once. A confirmation that lands while the window is not
  // eligible is kept back until it is.
  revealed: boolean
}

export interface DisplayConditions {
  /** The conversation is selected in a visible, focused window. */
  eligible: boolean
  /** Loaded lifecycle state is authoritative for the current connection. */
  synchronized: boolean
}

function isFinalDeadline(lifecycle: MessageLifecycle): boolean {
  return lifecycle.opened_at !== null
}

/** An incoming message this client has not had confirmed as opened. */
function awaitsOpening(entry: Entry): boolean {
  return entry.opening !== null && entry.opening !== 'confirmed'
}

/** Opened beats unopened; a final deadline never changes. */
function mergeLifecycle(current: MessageLifecycle, next: MessageLifecycle): MessageLifecycle {
  if (next.created_at !== current.created_at) return current
  if (isFinalDeadline(current) || next.opened_at === null) return current
  return next
}

function pickLifecycle({ delivery_policy, created_at, opened_at, expires_at }: MessageLifecycle): MessageLifecycle {
  return { delivery_policy, created_at, opened_at, expires_at }
}

/**
 * Loaded messages of one conversation, including verified and decrypted
 * incoming messages that are not yet displayable. Everything server-supplied
 * that reaches this store has been validated; lifecycle changes only move
 * forward, and removed messages cannot come back.
 */
export class ConversationMessages {
  private readonly entries = new Map<string, Entry>()
  private readonly removed = new Set<string>()
  private readonly updatesBeforeLoad = new Map<string, MessageLifecycle>()
  private readonly self: Address
  private serverOffset: number | null = null
  private clearedThrough = -Infinity

  /** `monotonic` measures elapsed time, as `performance.now()` does. */
  constructor(identityAddress: Address, private readonly monotonic: () => number = () => performance.now()) {
    this.self = identityAddress
  }

  /** Server time plus elapsed monotonic time; request latency shortens availability conservatively. */
  now(): number {
    return this.serverOffset === null ? Date.now() : this.monotonic() + this.serverOffset
  }

  hasServerTime(): boolean {
    return this.serverOffset !== null
  }

  private observeTime(serverTime: number, requestStarted: number): void {
    const offset = serverTime - requestStarted
    this.serverOffset = this.serverOffset === null ? offset : Math.max(this.serverOffset, offset)
  }

  add(messages: DecryptedMessage[]): void {
    for (const message of messages) {
      if (this.removed.has(message.id)) continue
      if (message.created_at <= this.clearedThrough) {
        this.remove(message.id)
        continue
      }
      const existing = this.entries.get(message.id)
      if (existing) {
        this.applyTo(existing, message)
        continue
      }
      const entry: Entry = {
        message,
        opening: message.recipient === this.self ? 'pending' : null,
        revealed: false,
      }
      this.entries.set(message.id, entry)
      const update = this.updatesBeforeLoad.get(message.id)
      if (update) {
        this.updatesBeforeLoad.delete(message.id)
        this.applyTo(entry, update)
      }
    }
  }

  /**
   * Applies authoritative lifecycle state such as an expiry update, holding
   * it until the message loads if necessary. It never reveals an incoming
   * message: that still needs this client's opening.
   */
  applyLifecycle(id: string, lifecycle: MessageLifecycle): void {
    if (this.removed.has(id)) return
    const entry = this.entries.get(id)
    if (entry) {
      this.applyTo(entry, lifecycle)
      return
    }
    const prior = this.updatesBeforeLoad.get(id)
    this.updatesBeforeLoad.set(id, prior ? mergeLifecycle(prior, lifecycle) : pickLifecycle(lifecycle))
  }

  /**
   * Removes every message accepted through `clearedAt`, including ones a
   * recovery or history request still in flight delivers later.
   */
  clear(clearedAt: number): void {
    this.clearedThrough = Math.max(this.clearedThrough, clearedAt)
    for (const [id, entry] of this.entries) {
      if (entry.message.created_at <= this.clearedThrough) this.remove(id)
    }
  }

  ids(): string[] {
    return [...this.entries.keys()]
  }

  /** Marks pending incoming messages as requested and returns their IDs. */
  takePending(): string[] {
    const ids: string[] = []
    for (const [id, entry] of this.entries) {
      if (entry.opening !== 'pending') continue
      entry.opening = 'requested'
      ids.push(id)
    }
    return ids
  }

  /** A lost connection invalidates requests without turning them into user failures. */
  cancelOpening(): void {
    for (const entry of this.entries.values()) if (entry.opening === 'requested') entry.opening = 'pending'
  }

  failOpening(ids: string[]): void {
    for (const id of ids) {
      const entry = this.entries.get(id)
      if (entry?.opening === 'requested') entry.opening = 'failed'
    }
  }

  hasFailedOpenings(): boolean {
    for (const entry of this.entries.values()) if (entry.opening === 'failed') return true
    return false
  }

  /** Returns failed incoming messages to pending for another opening request. */
  retryFailed(): void {
    for (const entry of this.entries.values()) if (entry.opening === 'failed') entry.opening = 'pending'
  }

  /**
   * Applies an opening response to the requested IDs. Available IDs are
   * confirmed independently, unavailable ones are removed, and missing,
   * duplicate or invalid results fail for retry.
   */
  confirmOpening(ids: string[], response: ConfirmationResponse | null, requestStarted = this.monotonic()): void {
    for (const id of ids) {
      const entry = this.entries.get(id)
      if (entry?.opening !== 'requested') continue
      const result = response && confirmMessage(entry.message, response, 'opening')
      if (result === 'unavailable') {
        this.remove(id)
        continue
      }
      if (!response || !result) {
        entry.opening = 'failed'
        continue
      }
      this.applyTo(entry, result)
      this.observeTime(response.server_time, requestStarted)
      entry.opening = 'confirmed'
    }
  }

  /**
   * Applies a lifecycle lookup: available states merge forward and
   * unavailable IDs are removed. Returns false when any loaded ID lacks
   * exactly one valid result, so the refresh cannot count as authoritative.
   */
  applyStates(ids: string[], response: ConfirmationResponse | null, requestStarted = this.monotonic()): boolean {
    if (!response) return false
    let complete = true
    for (const id of ids) {
      const entry = this.entries.get(id)
      if (!entry) continue
      const result = confirmMessage(entry.message, response, 'availability')
      if (result === 'unavailable') this.remove(id)
      else if (result) {
        this.applyTo(entry, result)
        this.observeTime(response.server_time, requestStarted)
      }
      else complete = false
    }
    return complete
  }

  /**
   * Messages to show now, oldest first. Incoming messages need a confirmed
   * opening and an unexpired deadline; displaying them records the reveal.
   * While out of sync, only deadlines that can no longer change are shown.
   */
  display(now: number, conditions: DisplayConditions): DecryptedMessage[] {
    const shown: DecryptedMessage[] = []
    if (!this.hasServerTime()) return shown
    for (const entry of this.entries.values()) {
      if (now >= entry.message.expires_at) continue
      if (!conditions.synchronized && !isFinalDeadline(entry.message)) continue
      if (entry.opening !== null) {
        if (entry.opening !== 'confirmed' || !(entry.revealed || conditions.eligible)) continue
        entry.revealed = true
      }
      shown.push(entry.message)
    }
    return shown.sort((a, b) => a.created_at - b.created_at)
  }

  /**
   * The newest acceptance time through which nothing awaits an opening
   * confirmation. Sender copies and confirmed incoming messages count as
   * read; nothing at or after an unconfirmed incoming message does.
   */
  seenThrough(): number | null {
    let unconfirmed = Infinity
    for (const entry of this.entries.values()) {
      if (awaitsOpening(entry)) unconfirmed = Math.min(unconfirmed, entry.message.created_at)
    }
    let seen: number | null = null
    for (const entry of this.entries.values()) {
      const { created_at } = entry.message
      if (!awaitsOpening(entry) && created_at < unconfirmed && (seen === null || created_at > seen)) seen = created_at
    }
    return seen
  }

  /**
   * Drops expired messages. Out of sync, an unopened deadline may already
   * have been replaced by an opening elsewhere, so such messages stay
   * (hidden) until an authoritative refresh decides.
   */
  sweep(now: number, { synchronized }: Pick<DisplayConditions, 'synchronized'>): void {
    // Even a final sender copy needs an authoritative clock before a local
    // expiry check can permanently remove it.
    if (!this.hasServerTime()) return
    for (const [id, entry] of this.entries) {
      if (now >= entry.message.expires_at && (synchronized || isFinalDeadline(entry.message))) this.remove(id)
    }
  }

  /** The earliest deadline still ahead of `now`, for scheduling the next sweep. */
  nextDeadline(now: number): number | null {
    let next: number | null = null
    for (const { message } of this.entries.values()) {
      if (message.expires_at > now && (next === null || message.expires_at < next)) next = message.expires_at
    }
    return next
  }

  private remove(id: string): void {
    this.entries.delete(id)
    this.updatesBeforeLoad.delete(id)
    this.removed.add(id)
  }

  private applyTo(entry: Entry, lifecycle: MessageLifecycle): void {
    const valid = parseDeliveryLifecycle(entry.message.ttl, lifecycle)
    if (valid) entry.message = { ...entry.message, ...mergeLifecycle(pickLifecycle(entry.message), valid) }
  }
}
