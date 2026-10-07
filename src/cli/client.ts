import type { Address } from '../shared/address'
import type { Keypair } from '../shared/keypair'
import { CLIENT_UPDATE_REQUIRED_CODE } from '../shared/api-error'
import { parseDeliveryLifecycle, type ConfirmationKind, type ExpiryUpdate, type MessageLifecycle } from '../shared/message-envelope'
import { ApiError, confirmMessage, ProtocolClient, readApiError, sealMessage, unsealMessage, type ConfirmationResponse, type Conversation, type DecryptedMessage } from '../shared/protocol-client'

interface Confirmation {
  kind: ConfirmationKind
  operation: string
  request(api: ProtocolClient, partner: Address, ids: string[], token: string): Promise<ConfirmationResponse | null>
}

const CONFIRMATIONS: Record<'open' | 'state', Confirmation> = {
  open: { kind: 'opening', operation: 'opening', request: (api, partner, ids, token) => api.open(partner, ids, token) },
  state: { kind: 'availability', operation: 'availability check', request: (api, partner, ids, token) => api.states(partner, ids, token) },
}

const availabilityDeadline = Symbol('availabilityDeadline')
export interface PlainMessage extends MessageLifecycle {
  id: string
  sender: Address
  recipient: Address
  ttl: number
  plaintext: string
  [availabilityDeadline]: number
}
export interface MessagePage {
  messages: PlainMessage[]
  next_before_seq: number | null
}
interface ReadOptions {
  confirmAvailability?: boolean
}

export function isMessageAvailable(message: PlainMessage): boolean {
  return performance.now() < message[availabilityDeadline]
}

function canReceiveExpiryUpdate(message: PlainMessage): boolean {
  return message.opened_at === null
    && performance.now() < message[availabilityDeadline] + message.ttl * 1000
}

export function shouldRetainMessage(message: PlainMessage): boolean {
  return isMessageAvailable(message) || canReceiveExpiryUpdate(message)
}

/** Applies a server-published first-opening lifecycle update to a loaded message. */
export function applyExpiryUpdate(message: PlainMessage, update: ExpiryUpdate): boolean {
  if (update.id !== message.id || update.sender !== message.sender || update.recipient !== message.recipient) return false
  const lifecycle = parseDeliveryLifecycle(message.ttl, update)
  if (!lifecycle || lifecycle.created_at !== message.created_at) return false
  // A message can move from its unopened deadline to its
  // final deadline exactly once. Never let a stale event undo that change.
  if (message.opened_at !== null && lifecycle.opened_at !== message.opened_at) return false
  if (lifecycle.opened_at === message.opened_at && lifecycle.expires_at === message.expires_at) return false
  // Keep the server-time/monotonic mapping established by confirmation.
  // Repeated events must neither restart a timer nor consult the wall clock.
  message[availabilityDeadline] += lifecycle.expires_at - message.expires_at
  Object.assign(message, lifecycle)
  return true
}

export function serverOrigin(value: string): string {
  if (value === 'prod') value = 'https://chat.endziu.xyz'
  if (value === 'local') value = 'http://localhost:3000'
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Server must be an origin, for example https://chat.example.com')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Use HTTPS, or HTTP on localhost for development')
  }
  return url.origin
}

/** The server no longer accepts this client's delivery protocol; retrying cannot help. */
export class ClientUpdateRequiredError extends Error {
  constructor() {
    super('This 0xChat CLI is out of date for this server. Update it with git pull && bun install, then retry.')
  }
}

export class ChatClient {
  readonly origin: string
  private readonly api: ProtocolClient
  private token: string | null = null
  private loginPending: Promise<void> | null = null
  private readonly controller = new AbortController()
  /** Aborted by abort(), or with a ClientUpdateRequiredError once the server refuses this client. */
  readonly signal = this.controller.signal
  /** Cancels requests along with `signal` until close() detaches it to send its logout. */
  private requestSignal: AbortSignal | undefined = this.signal

  constructor(origin: string, readonly identity: Keypair) {
    this.origin = serverOrigin(origin)
    this.api = new ProtocolClient(this.origin, (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('Origin', this.origin)
      return this.fetch(path, {
        ...init,
        headers,
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(this.requestSignal ? [this.requestSignal] : [])]),
      })
    }, error => this.stopIfOutdated(error))
  }

  /** Cancels pending and later requests; close() still sends its logout. */
  abort(): void {
    this.controller.abort()
  }

  private stopIfOutdated(error: ApiError): Error | void {
    if (error.code !== CLIENT_UPDATE_REQUIRED_CODE) return
    // Every later request would be refused too, so stop everything at once.
    const stopped = new ClientUpdateRequiredError()
    this.controller.abort(stopped)
    return stopped
  }

  /** Runs an authenticated request, signing in first and once more if the session has expired. */
  private async authenticated<T>(request: (token: string) => Promise<T>): Promise<T> {
    if (!this.token) await this.login()
    try {
      return await request(this.token!)
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error
      this.token = null
      await this.login()
      return request(this.token!)
    }
  }

  private async fetch(path: string, options: RequestInit): Promise<Response> {
    try { return await fetch(this.origin + path, options) }
    catch (cause) {
      if (options.signal?.aborted) throw cause
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(this.origin).hostname)
      const hint = local
        ? 'Start the local server with bun run dev, or select production with --server prod.'
        : 'Check your connection and the server URL, or select local development with --server local.'
      throw new Error(`Cannot connect to ${this.origin}. ${hint}`, { cause })
    }
  }

  register(): Promise<void> {
    return this.api.register(this.identity)
  }

  async login(): Promise<void> {
    if (this.loginPending) return this.loginPending
    this.loginPending = this.openSession()
    try { await this.loginPending } finally { this.loginPending = null }
  }

  private async openSession(): Promise<void> {
    if (await this.api.pubkey(this.identity.address) === null) await this.register()
    this.token = await this.api.login(this.identity)
  }

  async close(): Promise<void> {
    if (!this.token) return
    // Shutdown must work after the interactive operation was cancelled.
    this.requestSignal = undefined
    try { await this.api.deleteSession(this.token) }
    finally { this.token = null }
  }

  async send(recipient: Address, plaintext: string, ttl = 300): Promise<PlainMessage> {
    const pubkey = await this.api.pubkey(recipient)
    if (!pubkey) throw new Error('Recipient not registered')
    const envelope = await sealMessage(this.identity, recipient, pubkey, plaintext, ttl)
    return this.plain(await this.authenticated(token => this.api.send(this.identity, envelope, token)))
  }

  async decode(input: unknown, partner: Address): Promise<PlainMessage> {
    return this.plain(await unsealMessage(this.identity, input, partner))
  }

  private plain(message: DecryptedMessage): PlainMessage {
    return { id: message.id, sender: message.sender, recipient: message.recipient, ttl: message.ttl,
      delivery_policy: message.delivery_policy, created_at: message.created_at, opened_at: message.opened_at,
      expires_at: message.expires_at, plaintext: message.plaintext,
      [availabilityDeadline]: performance.now() + Math.max(0, message.expires_at - Date.now()) }
  }

  async conversations(): Promise<{ conversations: Conversation[] }> {
    return { conversations: await this.authenticated(token => this.api.conversations(token)) }
  }

  private async confirmMessages(
    partner: Address,
    messages: PlainMessage[],
    action: 'open' | 'state',
  ): Promise<Map<string, MessageLifecycle>> {
    const confirmed = new Map<string, MessageLifecycle>()
    if (!messages.length) return confirmed
    const { kind, operation, request } = CONFIRMATIONS[action]
    let response: ConfirmationResponse | null
    const requestStarted = performance.now()
    const ids = messages.map(message => message.id)
    try {
      response = await this.authenticated(token => request(this.api, partner, ids, token))
    } catch (error) {
      // A stopped client reports why it stopped, not a retry hint.
      if (this.signal.aborted) throw error
      throw new Error(`Message ${operation} failed; retry read to confirm availability`)
    }
    if (!response) throw new Error('Invalid message confirmation response')
    for (const message of messages) {
      const lifecycle = confirmMessage(message, response, kind)
      if (!lifecycle || lifecycle === 'unavailable') continue
      confirmed.set(message.id, lifecycle)
      message[availabilityDeadline] = requestStarted + lifecycle.expires_at - response.server_time
    }
    return confirmed
  }

  async read(partner: Address, beforeSeq?: number, options: ReadOptions = {}): Promise<MessagePage> {
    const page = await this.authenticated(token => this.api.history(partner, token, { before: beforeSeq, limit: 100 }))
    const decoded = await Promise.all(page.messages.map(raw => this.decode(raw, partner).catch(() => null)))
    const messages = decoded.filter(message => message !== null)
    const identity = this.identity.address
    const isIncoming = (message: PlainMessage) => message.recipient === identity
    const incoming = messages.filter(isIncoming)
    const confirmAvailability = options.confirmAvailability ?? true
    const confirmed = new Map<string, MessageLifecycle>()
    if (confirmAvailability) {
      const senderCopies = messages.filter(message => !isIncoming(message))
      for (const [id, lifecycle] of await this.confirmMessages(partner, senderCopies, 'state')) confirmed.set(id, lifecycle)
      for (const [id, lifecycle] of await this.confirmMessages(partner, incoming, 'open')) confirmed.set(id, lifecycle)
    }
    return { next_before_seq: page.next_before_seq, messages: messages.flatMap(msg => {
      if (confirmAvailability) {
        const lifecycle = confirmed.get(msg.id)
        if (!lifecycle) return []
        msg = { ...msg, ...lifecycle }
      }
      return isMessageAvailable(msg) ? [msg] : []
    }).reverse() }
  }

  /** Decrypts a live delivery, then confirms its current availability before exposing it. */
  async confirmLiveMessage(partner: Address, raw: unknown): Promise<PlainMessage | null> {
    const message = await this.decode(raw, partner)
    const incoming = message.recipient === this.identity.address
    const lifecycle = (await this.confirmMessages(partner, [message], incoming ? 'open' : 'state')).get(message.id)
    return lifecycle ? { ...message, ...lifecycle } : null
  }

  async *history(partner: Address, options: ReadOptions = {}): AsyncGenerator<PlainMessage[]> {
    let before: number | undefined
    const cursors = new Set<number>()
    do {
      const page = await this.read(partner, before, options)
      yield page.messages
      if (page.next_before_seq === null) return
      if (cursors.has(page.next_before_seq)) throw new Error('Server repeated a pagination cursor')
      cursors.add(page.next_before_seq)
      before = page.next_before_seq
    } while (true)
  }

  async *events(signal: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
    const sseToken = await this.authenticated(token => this.api.sseToken(token))
    const controller = new AbortController()
    const connectTimer = setTimeout(() => controller.abort(), 15_000)
    let response: Response
    try {
      response = await this.fetch(`/api/events?token=${encodeURIComponent(sseToken)}`, {
        redirect: 'error',
        signal: AbortSignal.any([signal, controller.signal]),
      })
    } finally { clearTimeout(connectTimer) }
    if (!response.ok || !response.body) {
      // Read only to abort this client if the server requires an update.
      if (!response.ok) this.stopIfOutdated(await readApiError(response))
      controller.abort()
      throw new Error(`Live connection failed: HTTP ${response.status}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const timer = setTimeout(() => controller.abort(), 65_000)
        let result: Awaited<ReturnType<typeof reader.read>>
        try { result = await reader.read() } finally { clearTimeout(timer) }
        if (result.done) return
        buffer += decoder.decode(result.value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const lines = frame.split('\n')
          yield {
            // An unnamed frame is a 'message', as in the browser's EventSource.
            event: lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message',
            data: lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'),
          }
        }
        if (buffer.length > 4_100_000) throw new Error('Live event exceeds message size limit')
      }
    } finally {
      controller.abort()
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}
