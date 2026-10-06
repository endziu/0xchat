import { requireAddress, type Address } from '../../shared/address'
import { clearTokenIfMatches } from './session'
import { verifyEncryptionPublicKey } from './encryption-key'
import { isApiErrorCode, type ApiErrorCode } from '../../shared/api-error'
import { buildRegistrationChallenge } from '../../shared/registration-challenge'
import { buildSessionChallenge } from '../../shared/session-challenge'
import { DELIVERY_CAPABILITY, type DeliveredMessage, type MessageEnvelope } from '../../shared/message-envelope'


export type Message = DeliveredMessage

/** Dispatched when the server requires a newer client; retrying cannot succeed. */
export const CLIENT_UPDATE_REQUIRED_EVENT = 'client:update-required'

export class ApiError extends Error {
  constructor(message: string, readonly code?: ApiErrorCode) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface RecoveryPage {
  messages: unknown[]
  exhausted: boolean
  next_cursor: string | null
  recovery_cursor: string | null
}

export interface MessagePage {
  recovery_cursor: string
  messages: unknown[]
  // Server-issued cursor at the oldest returned message; null for an empty page.
  next_before_seq: number | null
}

export interface Conversation {
  address: Address
  last_message_at: number
}

// Auth is a per-request dependency: every caller passes the bearer token for
// its own request. There is no shared module state to go stale on identity
// switch. `null` is only valid for public / pre-auth endpoints.
async function request<T>(path: string, options: RequestInit, token: string | null): Promise<T> {
  const headers = new Headers(options.headers)
  // Separate from the signed envelope version: tells the server this client
  // implements recipient-opening expiry.
  headers.set('X-0xChat-Delivery-Capability', DELIVERY_CAPABILITY)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const res = await fetch(path, { ...options, headers })
  if (res.status === 401) {
    // Invalidate only the session that actually produced this token. A delayed
    // request carrying a previous identity's token must not clear (or sign out)
    // a newer session that has since been committed.
    const invalidated = token ? clearTokenIfMatches(token) : false
    if (invalidated) {
      // Trigger a page reload or state update to handle logout
      // but not for DELETE (logout already in progress) or auth endpoints
      if (!path.includes('/api/auth/') && !path.includes('/api/addresses/')) {
        globalThis.dispatchEvent(new CustomEvent('auth:expired'))
      }
    }
  }
  if (!res.ok) {
    const parsedBody: unknown = await res.json().catch(() => null)
    const body = typeof parsedBody === 'object' && parsedBody !== null
      ? parsedBody as { error?: unknown; code?: unknown }
      : {}
    const message = typeof body.error === 'string' && body.error ? body.error : res.statusText
    const code = isApiErrorCode(body.code) ? body.code : undefined
    if (code === 'client_update_required') globalThis.dispatchEvent(new CustomEvent(CLIENT_UPDATE_REQUIRED_EVENT))
    throw new ApiError(message, code)
  }

  if (res.status === 204) return {} as T
  return res.json()
}

export const api = {
  // --- Public / pre-auth endpoints (no session required) ---

  getRegChallenge: async (address: Address, pubkey: string): Promise<{ challenge: string; nonce: string }> => {
    const normalizedPubkey = verifyEncryptionPublicKey(address, pubkey)
    const result = await request<{ challenge: string; nonce: string }>('/api/register/challenge', {
      method: 'POST',
      body: JSON.stringify({ address, pubkey: normalizedPubkey }),
      headers: { 'Content-Type': 'application/json' },
    }, null)
    const expected = buildRegistrationChallenge(
      window.location.origin,
      address,
      normalizedPubkey,
      result.nonce,
    )
    if (result.challenge !== expected) throw new Error('Invalid registration challenge')
    return result
  },

  register: (address: Address, pubkey: string, signature: string, nonce: string) =>
    request('/api/register', {
      method: 'POST',
      body: JSON.stringify({ address, pubkey, signature, nonce }),
      headers: { 'Content-Type': 'application/json' },
    }, null),

  getPubkey: async (address: Address): Promise<{ pubkey: string | null }> => {
    const result = await request<{ pubkey: string | null }>(`/api/pubkey/${address}`, {}, null)
    return {
      pubkey: result.pubkey === null ? null : verifyEncryptionPublicKey(address, result.pubkey),
    }
  },

  getChallenge: async (address: Address): Promise<{ challenge: string; nonce: string }> => {
    const result = await request<{ challenge: string; nonce: string }>('/api/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ address }),
      headers: { 'Content-Type': 'application/json' },
    }, null)
    const expected = buildSessionChallenge(
      window.location.origin,
      address,
      result.nonce,
    )
    if (result.challenge !== expected) throw new Error('Invalid session challenge')
    return result
  },

  createSession: (address: Address, signature: string, nonce: string): Promise<{ token: string }> =>
    request('/api/auth/session', {
      method: 'POST',
      body: JSON.stringify({ address, signature, nonce }),
      headers: { 'Content-Type': 'application/json' },
    }, null),

  getVapidPublicKey: (): Promise<{ publicKey: string }> =>
    request('/api/push/vapid-public-key', {}, null),

  // --- Authenticated endpoints (a session token is required) ---

  sendMessage: (data: MessageEnvelope, token: string): Promise<DeliveredMessage> =>
    request('/api/messages', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    }, token),

  getMessages: (address: Address, token: string, beforeSeq?: number, limit?: number): Promise<MessagePage> => {
    const params = new URLSearchParams()
    if (beforeSeq != null) params.set('before_seq', String(beforeSeq))
    if (limit != null) params.set('limit', String(limit))
    const query = params.toString()
    return request(`/api/messages/${address}${query ? `?${query}` : ''}`, {}, token)
  },

  recoverMessages: (address: Address, token: string, cursor: { after: string } | { cursor: string }): Promise<RecoveryPage> =>
    request(`/api/messages/${address}/recover?${new URLSearchParams(cursor)}`, {}, token),

  // Opening starts message lifetimes; state lookup never does. Both
  // responses are server input and are validated by the caller.
  openMessages: (address: Address, ids: string[], token: string): Promise<unknown> =>
    request(`/api/messages/${address}/open`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
      headers: { 'Content-Type': 'application/json' },
    }, token),

  getMessageStates: (address: Address, ids: string[], token: string): Promise<unknown> =>
    request(`/api/messages/${address}/state`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
      headers: { 'Content-Type': 'application/json' },
    }, token),

  clearConversation: (address: Address, token: string): Promise<{ cleared_at: number }> =>
    request(`/api/messages/${address}`, { method: 'DELETE' }, token),

  getConversations: async (token: string): Promise<{ conversations: Conversation[] }> => {
    const result = await request<{ conversations: { address: unknown; last_message_at: number }[] }>('/api/conversations', {}, token)
    return { conversations: result.conversations.map(item => ({ ...item, address: requireAddress(item.address) })) }
  },

  getSseToken: (token: string): Promise<{ sse_token: string }> =>
    request('/api/events/token', { method: 'POST' }, token),

  setSseAttention: (token: string, stream: string, attentive: boolean, sequence: number): Promise<unknown> =>
    request('/api/events/attention', {
      method: 'POST',
      body: JSON.stringify({ stream, attentive, sequence }),
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    }, token),

  deleteSession: (token: string) =>
    request('/api/session', { method: 'DELETE' }, token),

  deleteAddress: (address: Address, token: string) =>
    request(`/api/addresses/${address}`, { method: 'DELETE' }, token),

  subscribePush: (subscription: PushSubscriptionJSON, token: string) =>
    request('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription),
      headers: { 'Content-Type': 'application/json' },
    }, token),

  unsubscribePush: (endpoint: string, token: string) =>
    request('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
      headers: { 'Content-Type': 'application/json' },
    }, token),
}
