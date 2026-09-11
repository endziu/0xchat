import { getAddress } from 'viem'
import { signEIP191, type Keypair } from '../client/lib/burner'
import { decrypt } from '../client/lib/crypto'
import { verifyEncryptionPublicKey } from '../client/lib/encryption-key'
import { createSignedMessageEnvelope } from '../client/lib/message-envelope'
import { buildRegistrationChallenge } from '../shared/registration-challenge'
import { buildSessionChallenge } from '../shared/session-challenge'
import { canonicalMessageAad, isEnvelopeParticipant, MAX_PLAINTEXT_BYTES, verifyDeliveredMessage, verifyMessageConfirmation, type ConfirmationKind, type MessageLifecycle, type OpeningResponse } from '../shared/message-envelope'

export const LIFETIMES = [5, 10, 30, 60, 300, 1800, 3600, 21600, 86400]
const availabilityDeadline = Symbol('availabilityDeadline')
export interface PlainMessage extends MessageLifecycle {
  id: string
  sender: string
  recipient: string
  ttl: number
  plaintext: string
  [availabilityDeadline]: number
}
export interface MessagePage {
  messages: PlainMessage[]
  next_before: number | null
  next_before_rowid: number | null
}
interface ReadOptions {
  confirmAvailability?: boolean
}

export function isMessageAvailable(message: PlainMessage): boolean {
  return performance.now() < message[availabilityDeadline]
}

export function address(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('Expected an Ethereum address (0x followed by 40 hex digits)')
  return getAddress(value).toLowerCase()
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

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export class ChatClient {
  readonly origin: string
  private token: string | null = null
  private loginPending: Promise<void> | null = null

  constructor(origin: string, readonly identity: Keypair, private signal?: AbortSignal) {
    this.origin = serverOrigin(origin)
  }

  private async request<T>(path: string, method = 'GET', body?: unknown, authenticated = true, retry = true): Promise<T> {
    if (authenticated && !this.token) await this.login()
    const response = await this.fetch(path, {
      method,
      headers: {
        Origin: this.origin,
        'Content-Type': 'application/json',
        ...(authenticated ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(this.signal ? [this.signal] : [])]),
    })
    if (response.status === 401 && authenticated && retry) {
      this.token = null
      await this.login()
      return this.request(path, method, body, authenticated, false)
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: unknown }
      throw new HttpError(response.status, typeof data.error === 'string' ? data.error : `HTTP ${response.status}`)
    }
    return response.status === 204 ? undefined as T : await response.json() as T
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

  async register(): Promise<void> {
    const { address, publicKey: pubkey } = this.identity
    const result = await this.request<{ challenge: string; nonce: string }>('/api/register/challenge', 'POST', { address, pubkey }, false)
    if (result.challenge !== buildRegistrationChallenge(this.origin, address, pubkey, result.nonce)) {
      throw new Error('Invalid registration challenge')
    }
    const signature = await signEIP191(result.challenge, this.identity.privateKey)
    await this.request('/api/register', 'POST', { address, pubkey, nonce: result.nonce, signature }, false)
  }

  async login(): Promise<void> {
    if (this.loginPending) return this.loginPending
    this.loginPending = this.openSession()
    try { await this.loginPending } finally { this.loginPending = null }
  }

  private async openSession(): Promise<void> {
    const address = this.identity.address
    const { pubkey } = await this.request<{ pubkey: string | null }>(`/api/pubkey/${address}`, 'GET', undefined, false)
    if (pubkey === null) await this.register()
    else verifyEncryptionPublicKey(address, pubkey)
    const result = await this.request<{ challenge: string; nonce: string }>('/api/auth/challenge', 'POST', { address }, false)
    if (result.challenge !== buildSessionChallenge(this.origin, address, result.nonce)) throw new Error('Invalid session challenge')
    const signature = await signEIP191(result.challenge, this.identity.privateKey)
    const session = await this.request<{ token: string }>('/api/auth/session', 'POST', { address, nonce: result.nonce, signature }, false)
    if (typeof session.token !== 'string' || !/^[0-9a-f]{64}$/.test(session.token)) throw new Error('Invalid session token')
    this.token = session.token
  }

  async close(): Promise<void> {
    if (!this.token) return
    // Shutdown must work after the interactive operation was cancelled.
    this.signal = undefined
    try { await this.request('/api/session', 'DELETE', undefined, true, false) }
    finally { this.token = null }
  }

  async send(to: string, plaintext: string, ttl = 300): Promise<PlainMessage> {
    const recipient = address(to)
    if (recipient === this.identity.address.toLowerCase()) throw new Error('Cannot message yourself')
    if (!LIFETIMES.includes(ttl)) throw new Error(`Lifetime must be one of: ${LIFETIMES.join(', ')} seconds`)
    if (!plaintext.trim()) throw new Error('Message must not be empty')
    if (new TextEncoder().encode(plaintext).length > MAX_PLAINTEXT_BYTES) throw new Error('Message is too large')
    const { pubkey } = await this.request<{ pubkey: string | null }>(`/api/pubkey/${recipient}`, 'GET', undefined, false)
    if (!pubkey) throw new Error('Recipient not registered')
    const envelope = await createSignedMessageEnvelope(plaintext, ttl, this.identity, recipient, verifyEncryptionPublicKey(recipient, pubkey))
    const result = await this.request<unknown>('/api/messages', 'POST', envelope)
    const message = await this.decode(result, recipient)
    if (!message || message.id !== envelope.id) throw new Error('Invalid message acknowledgement')
    return message
  }

  async decode(input: unknown, partner: string): Promise<PlainMessage | null> {
    const msg = await verifyDeliveredMessage(input)
    if (!msg || !isEnvelopeParticipant(msg, this.identity.address, partner)) throw new Error('Rejected unauthenticated or misaddressed message')
    const mine = msg.sender === this.identity.address.toLowerCase()
    const plaintext = await decrypt(
      mine ? msg.ct_sender : msg.ct_recipient,
      mine ? msg.ephemeral_pub_sender : msg.ephemeral_pub_recipient,
      mine ? msg.iv_sender : msg.iv_recipient,
      this.identity.privateKey, canonicalMessageAad(msg),
    )
    return { id: msg.id, sender: msg.sender, recipient: msg.recipient, ttl: msg.ttl,
      delivery_policy: msg.delivery_policy, created_at: msg.created_at, opened_at: msg.opened_at,
      expires_at: msg.expires_at, plaintext,
      [availabilityDeadline]: performance.now() + Math.max(0, msg.expires_at - Date.now()) }
  }

  conversations(): Promise<{ conversations: { address: string; last_message_at: number }[] }> {
    return this.request('/api/conversations')
  }

  private async confirmMessages(
    partner: string,
    messages: Array<{ raw: unknown; message: PlainMessage }>,
    action: 'open' | 'state',
  ): Promise<Map<string, MessageLifecycle>> {
    const confirmed = new Map<string, MessageLifecycle>()
    if (!messages.length) return confirmed
    let response: OpeningResponse
    const requestStarted = performance.now()
    try {
      response = await this.request<OpeningResponse>(`/api/messages/${partner}/${action}`, 'POST',
        { ids: messages.map(item => item.message.id) })
    } catch {
      const operation = action === 'open' ? 'opening' : 'availability check'
      throw new Error(`Message ${operation} failed; retry read to confirm availability`)
    }
    if (!response || !Number.isSafeInteger(response.server_time) || response.server_time < 0
      || !Array.isArray(response.results)) throw new Error('Invalid message confirmation response')
    for (const { raw, message } of messages) {
      const results = response.results.filter(result => result && result.id === message.id)
      if (results.length !== 1 || results[0]!.status !== 'available') continue
      const result = results[0]!
      const kind: ConfirmationKind = action === 'open' ? 'opening' : 'availability'
      const lifecycle = await verifyMessageConfirmation(raw, result, response.server_time, kind)
      if (!lifecycle) continue
      confirmed.set(message.id, lifecycle)
      message[availabilityDeadline] = requestStarted + lifecycle.expires_at - response.server_time
    }
    return confirmed
  }

  async read(partner: string, before?: number, rowid?: number, options: ReadOptions = {}): Promise<MessagePage> {
    partner = address(partner)
    const query = new URLSearchParams({ limit: '100' })
    if (before !== undefined) query.set('before', String(before))
    if (rowid !== undefined) query.set('before_rowid', String(rowid))
    const page = await this.request<{ messages: unknown[]; next_before: number | null; next_before_rowid: number | null }>(`/api/messages/${partner}?${query}`)
    const decoded = await Promise.all(page.messages.map(async raw => {
      try {
        const message = await this.decode(raw, partner)
        return message ? { raw, message } : null
      } catch { return null }
    }))
    const messages = decoded.filter((item): item is { raw: unknown; message: PlainMessage } => item !== null)
    const identity = this.identity.address.toLowerCase()
    const isIncoming = (message: PlainMessage) => message.recipient === identity
    const incoming = messages.filter(item => isIncoming(item.message))
    const confirmAvailability = options.confirmAvailability ?? true
    const confirmed = new Map<string, MessageLifecycle>()
    if (confirmAvailability) {
      const senderCopies = messages.filter(item => !isIncoming(item.message))
      for (const [id, lifecycle] of await this.confirmMessages(partner, senderCopies, 'state')) confirmed.set(id, lifecycle)
      for (const [id, lifecycle] of await this.confirmMessages(partner, incoming, 'open')) confirmed.set(id, lifecycle)
    }
    return { next_before: page.next_before, next_before_rowid: page.next_before_rowid, messages: messages.flatMap(({ message: msg }) => {
      if (confirmAvailability) {
        const lifecycle = confirmed.get(msg.id)
        if (!lifecycle) return []
        msg = { ...msg, ...lifecycle }
      }
      return isMessageAvailable(msg) ? [msg] : []
    }).reverse() }
  }

  async *history(partner: string, options: ReadOptions = {}): AsyncGenerator<PlainMessage[]> {
    let before: number | undefined
    let rowid: number | undefined
    const cursors = new Set<string>()
    do {
      const page = await this.read(partner, before, rowid, options)
      yield page.messages
      if (page.next_before === null) return
      const cursor = `${page.next_before}:${page.next_before_rowid}`
      if (cursors.has(cursor)) throw new Error('Server repeated a pagination cursor')
      cursors.add(cursor)
      before = page.next_before
      rowid = page.next_before_rowid ?? undefined
    } while (true)
  }

  async *events(signal: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
    const { sse_token } = await this.request<{ sse_token: string }>('/api/events/token', 'POST')
    const controller = new AbortController()
    const connectTimer = setTimeout(() => controller.abort(), 15_000)
    let response: Response
    try {
      response = await this.fetch(`/api/events?token=${encodeURIComponent(sse_token)}`, {
        redirect: 'error',
        signal: AbortSignal.any([signal, controller.signal]),
      })
    } finally { clearTimeout(connectTimer) }
    if (!response.ok || !response.body) {
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
