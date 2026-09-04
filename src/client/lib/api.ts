import { clearTokenIfMatches } from './session'
import { verifyEncryptionPublicKey } from './encryption-key'
import { isApiErrorCode, type ApiErrorCode } from '../../shared/api-error'
import { buildRegistrationChallenge } from '../../shared/registration-challenge'
import type { DeliveredMessage, MessageEnvelope } from '../../shared/message-envelope'

export type Message = DeliveredMessage

export class ApiError extends Error {
  constructor(message: string, readonly code?: ApiErrorCode) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface MessagePage {
  messages: unknown[]
  // Server-issued cursor for the next older page; null when exhausted.
  next_before: number | null
  next_before_rowid: number | null
}

export interface Conversation {
  address: string
  last_message_at: number
}

// Auth is a per-request dependency: every caller passes the bearer token for
// its own request. There is no shared module state to go stale on identity
// switch. `null` is only valid for public / pre-auth endpoints.
async function request<T>(path: string, options: RequestInit, token: string | null): Promise<T> {
  const headers = new Headers(options.headers)
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
    throw new ApiError(message, code)
  }

  if (res.status === 204) return {} as T
  return res.json()
}

export const api = {
  // --- Public / pre-auth endpoints (no session required) ---

  getRegChallenge: async (address: string, pubkey: string): Promise<{ challenge: string; nonce: string }> => {
    const normalizedAddress = address.toLowerCase()
    const normalizedPubkey = verifyEncryptionPublicKey(normalizedAddress, pubkey)
    const result = await request<{ challenge: string; nonce: string }>('/api/register/challenge', {
      method: 'POST',
      body: JSON.stringify({ address: normalizedAddress, pubkey: normalizedPubkey }),
      headers: { 'Content-Type': 'application/json' },
    }, null)
    const expected = buildRegistrationChallenge(
      window.location.origin,
      normalizedAddress,
      normalizedPubkey,
      result.nonce,
    )
    if (result.challenge !== expected) throw new Error('Invalid registration challenge')
    return result
  },

  register: (address: string, pubkey: string, signature: string, nonce: string) =>
    request('/api/register', {
      method: 'POST',
      body: JSON.stringify({ address, pubkey, signature, nonce }),
      headers: { 'Content-Type': 'application/json' },
    }, null),

  getPubkey: async (address: string): Promise<{ pubkey: string | null }> => {
    const result = await request<{ pubkey: string | null }>(`/api/pubkey/${address}`, {}, null)
    return {
      pubkey: result.pubkey === null ? null : verifyEncryptionPublicKey(address, result.pubkey),
    }
  },

  getChallenge: (address: string): Promise<{ challenge: string; nonce: string }> =>
    request('/api/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ address }),
      headers: { 'Content-Type': 'application/json' },
    }, null),

  createSession: (address: string, signature: string, nonce: string): Promise<{ token: string }> =>
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

  getMessages: (address: string, token: string, before?: number, beforeRowid?: number, limit?: number): Promise<MessagePage> => {
    const params = new URLSearchParams()
    if (before != null) params.set('before', String(before))
    if (beforeRowid != null) params.set('before_rowid', String(beforeRowid))
    if (limit != null) params.set('limit', String(limit))
    const query = params.toString()
    return request(`/api/messages/${address}${query ? `?${query}` : ''}`, {}, token)
  },

  getConversations: (token: string): Promise<{ conversations: Conversation[] }> =>
    request('/api/conversations', {}, token),

  getSseToken: (token: string): Promise<{ sse_token: string }> =>
    request('/api/events/token', { method: 'POST' }, token),

  deleteSession: (token: string) =>
    request('/api/session', { method: 'DELETE' }, token),

  deleteAddress: (address: string, token: string) =>
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
