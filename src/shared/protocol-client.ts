import { requireAddress, type Address } from './address'
import { isApiErrorCode, type ApiErrorCode } from './api-error'
import { decrypt } from './crypto'
import { verifyEncryptionPublicKey } from './encryption-key'
import { signEIP191, type Keypair } from './keypair'
import { MESSAGE_TTLS } from './message-ttl'
import { buildRegistrationChallenge } from './registration-challenge'
import { buildSessionChallenge } from './session-challenge'
import { createSignedMessageEnvelope } from './signed-message-envelope'
import {
  canonicalMessageAad,
  DELIVERY_CAPABILITY,
  DELIVERY_CAPABILITY_HEADER,
  isEnvelopeParticipant,
  MAX_PLAINTEXT_BYTES,
  parseDeliveryLifecycle,
  verifyDeliveredMessage,
  type ConfirmationKind,
  type DeliveredMessage,
  type MessageEnvelope,
  type MessageLifecycle,
} from './message-envelope'

/** Fetches a server path, such as `/api/messages`; each client resolves it against its server. */
export type FetchPort = (path: string, init: RequestInit) => Promise<Response>

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: ApiErrorCode) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Called with every server error before it is thrown, and with the request
 * that caused it. A returned error is thrown instead.
 */
export type ApiErrorHandler = (error: ApiError, request: { path: string; token: string | null }) => Error | void

export type DecryptedMessage = DeliveredMessage & { plaintext: string }

export interface MessagePage {
  recovery_cursor: string
  messages: unknown[]
  // Server-issued cursor at the oldest returned message; null for an empty page.
  next_before_seq: number | null
}

export interface RecoveryPage {
  messages: unknown[]
  exhausted: boolean
  next_cursor: string | null
  recovery_cursor: string | null
}

export interface Conversation {
  address: Address
  last_message_at: number
}

/** An opening or state response; its per-ID results are checked with confirmMessage. */
export interface ConfirmationResponse {
  server_time: number
  results: Record<string, unknown>[]
}

/** Maps a server error response to an ApiError, keeping a known error code. */
export async function readApiError(response: Response): Promise<ApiError> {
  const parsed: unknown = await response.json().catch(() => null)
  const body = typeof parsed === 'object' && parsed !== null ? parsed as { error?: unknown; code?: unknown } : {}
  const message = typeof body.error === 'string' && body.error ? body.error : response.statusText || `HTTP ${response.status}`
  return new ApiError(message, response.status, isApiErrorCode(body.code) ? body.code : undefined)
}

/** Validates a message and encrypts and signs it for its recipient and its sender. */
export async function sealMessage(
  identity: Keypair,
  recipient: Address,
  recipientPublicKey: string,
  plaintext: string,
  ttl: number,
): Promise<MessageEnvelope> {
  if (recipient === identity.address) throw new Error('Cannot message yourself')
  if (!MESSAGE_TTLS.includes(ttl)) throw new Error(`Lifetime must be one of: ${MESSAGE_TTLS.join(', ')} seconds`)
  if (!plaintext.trim()) throw new Error('Message must not be empty')
  if (new TextEncoder().encode(plaintext).length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`Message is too large (maximum ${MAX_PLAINTEXT_BYTES} UTF-8 bytes)`)
  }
  return createSignedMessageEnvelope(plaintext, ttl, identity, recipient, verifyEncryptionPublicKey(recipient, recipientPublicKey))
}

/**
 * Verifies a delivered message of the conversation between `identity` and
 * `partner`, then decrypts the copy encrypted to `identity`. Rejects forged,
 * misaddressed and undecryptable messages. This is the only signature check:
 * confirmations are checked against the returned message.
 */
export async function unsealMessage(identity: Keypair, input: unknown, partner: Address): Promise<DecryptedMessage> {
  const message = await verifyDeliveredMessage(input)
  if (!message || !isEnvelopeParticipant(message, identity.address, partner)) {
    throw new Error('Rejected unauthenticated or misaddressed message')
  }
  const mine = message.sender === identity.address
  try {
    const plaintext = await decrypt(
      mine ? message.ct_sender : message.ct_recipient,
      mine ? message.ephemeral_pub_sender : message.ephemeral_pub_recipient,
      mine ? message.iv_sender : message.iv_recipient,
      identity.privateKey,
      canonicalMessageAad(message),
    )
    return { ...message, plaintext }
  } catch (cause) {
    throw new Error('Rejected undecryptable message', { cause })
  }
}

export function parseConfirmationResponse(input: unknown): ConfirmationResponse | null {
  if (typeof input !== 'object' || input === null) return null
  const { server_time, results } = input as { server_time?: unknown; results?: unknown }
  if (!Number.isSafeInteger(server_time) || (server_time as number) < 0 || !Array.isArray(results)) return null
  return {
    server_time: server_time as number,
    results: results.filter((result): result is Record<string, unknown> => typeof result === 'object' && result !== null),
  }
}

/**
 * The single result for a verified message in an opening or state response:
 * 'unavailable', or its lifecycle checked against the message's signed
 * lifetime, its acceptance and server time. An opening must report an opened
 * message. Missing, duplicated or invalid results are null.
 *
 * A final deadline never changes: a different one is invalid, and an
 * unopened result for an opened message is stale, so the final one is kept.
 */
export function confirmMessage(
  message: Pick<DeliveredMessage, 'id' | 'ttl'> & MessageLifecycle,
  response: ConfirmationResponse,
  kind: ConfirmationKind,
): MessageLifecycle | 'unavailable' | null {
  const matches = response.results.filter(result => result['id'] === message.id)
  if (matches.length !== 1) return null
  const result = matches[0]!
  if (result['status'] === 'unavailable') return 'unavailable'
  const lifecycle = result['status'] === 'available' ? parseDeliveryLifecycle(message.ttl, result) : null
  const serverTime = response.server_time
  if (!lifecycle || lifecycle.created_at !== message.created_at
    || (kind === 'opening' && lifecycle.opened_at === null)
    || lifecycle.created_at > serverTime
    || (lifecycle.opened_at !== null && lifecycle.opened_at > serverTime)
    || lifecycle.expires_at <= serverTime) return null
  if (message.opened_at === null) return lifecycle
  if (lifecycle.opened_at !== null && lifecycle.opened_at !== message.opened_at) return null
  const { delivery_policy, created_at, opened_at, expires_at } = message
  return { delivery_policy, created_at, opened_at, expires_at }
}

interface RequestOptions {
  method?: string
  body?: unknown
  /** The session token; null for public and pre-auth endpoints. */
  token?: string | null
  keepalive?: boolean
}

/**
 * The client side of the 0xChat protocol: requests that advertise this
 * client's delivery capability, one error mapping, and validated responses.
 * Session tokens are passed per request, so nothing here outlives an identity.
 */
export class ProtocolClient {
  constructor(
    readonly origin: string,
    private readonly fetch: FetchPort,
    private readonly onError: ApiErrorHandler = () => {},
  ) {}

  async request<T>(path: string, { method = 'GET', body, token = null, keepalive }: RequestOptions = {}): Promise<T> {
    const headers = new Headers({ [DELIVERY_CAPABILITY_HEADER]: DELIVERY_CAPABILITY })
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const response = await this.fetch(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(keepalive ? { keepalive } : {}),
    })
    if (!response.ok) {
      const error = await readApiError(response)
      throw this.onError(error, { path, token }) ?? error
    }
    return response.status === 204 ? undefined as T : await response.json() as T
  }

  /** The address's encryption public key, verified against the address; null while unregistered. */
  async pubkey(address: Address): Promise<string | null> {
    const { pubkey } = await this.request<{ pubkey: string | null }>(`/api/pubkey/${address}`)
    return pubkey === null ? null : verifyEncryptionPublicKey(address, pubkey)
  }

  async register(identity: Keypair): Promise<void> {
    const { address } = identity
    const pubkey = verifyEncryptionPublicKey(address, identity.publicKey)
    const { challenge, nonce } = await this.request<{ challenge: string; nonce: string }>('/api/register/challenge', {
      method: 'POST', body: { address, pubkey },
    })
    if (challenge !== buildRegistrationChallenge(this.origin, address, pubkey, nonce)) throw new Error('Invalid registration challenge')
    const signature = await signEIP191(challenge, identity.privateKey)
    await this.request('/api/register', { method: 'POST', body: { address, pubkey, signature, nonce } })
  }

  /** Signs in as a registered identity; returns its session token. */
  async login(identity: Keypair): Promise<string> {
    const { address } = identity
    const { challenge, nonce } = await this.request<{ challenge: string; nonce: string }>('/api/auth/challenge', {
      method: 'POST', body: { address },
    })
    if (challenge !== buildSessionChallenge(this.origin, address, nonce)) throw new Error('Invalid session challenge')
    const signature = await signEIP191(challenge, identity.privateKey)
    const { token } = await this.request<{ token: unknown }>('/api/auth/session', {
      method: 'POST', body: { address, signature, nonce },
    })
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid session token')
    return token
  }

  /** Sends a sealed message; returns the server's acknowledgement, verified and decrypted. */
  async send(identity: Keypair, envelope: MessageEnvelope, token: string): Promise<DecryptedMessage> {
    const ack = await this.request<unknown>('/api/messages', { method: 'POST', body: envelope, token })
    const message = await unsealMessage(identity, ack, envelope.recipient)
    if (message.id !== envelope.id) throw new Error('Invalid message acknowledgement')
    return message
  }

  history(partner: Address, token: string, { before, limit }: { before?: number; limit?: number } = {}): Promise<MessagePage> {
    const query = new URLSearchParams()
    if (limit !== undefined) query.set('limit', String(limit))
    if (before !== undefined) query.set('before_seq', String(before))
    const search = query.toString()
    return this.request(`/api/messages/${partner}${search ? `?${search}` : ''}`, { token })
  }

  recover(partner: Address, token: string, cursor: { after: string } | { cursor: string }): Promise<RecoveryPage> {
    return this.request(`/api/messages/${partner}/recover?${new URLSearchParams(cursor)}`, { token })
  }

  /** Opens messages, which starts their lifetimes; null for a malformed response. */
  async open(partner: Address, ids: string[], token: string): Promise<ConfirmationResponse | null> {
    return parseConfirmationResponse(await this.request(`/api/messages/${partner}/open`, { method: 'POST', body: { ids }, token }))
  }

  /** Looks up message lifecycles without opening; null for a malformed response. */
  async states(partner: Address, ids: string[], token: string): Promise<ConfirmationResponse | null> {
    return parseConfirmationResponse(await this.request(`/api/messages/${partner}/state`, { method: 'POST', body: { ids }, token }))
  }

  clear(partner: Address, token: string): Promise<{ cleared_at: number }> {
    return this.request(`/api/messages/${partner}`, { method: 'DELETE', token })
  }

  async conversations(token: string): Promise<Conversation[]> {
    const { conversations } = await this.request<{ conversations: { address: unknown; last_message_at: number }[] }>('/api/conversations', { token })
    return conversations.map(item => ({ ...item, address: requireAddress(item.address) }))
  }

  async sseToken(token: string): Promise<string> {
    return (await this.request<{ sse_token: string }>('/api/events/token', { method: 'POST', token })).sse_token
  }

  async deleteSession(token: string): Promise<void> {
    await this.request('/api/session', { method: 'DELETE', token })
  }

  async deleteAddress(address: Address, token: string): Promise<void> {
    await this.request(`/api/addresses/${address}`, { method: 'DELETE', token })
  }
}
