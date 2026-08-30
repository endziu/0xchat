import { clearToken } from './session'
import { verifyEncryptionPublicKey } from './encryption-key'
import { buildRegistrationChallenge } from '../../shared/registration-challenge'
import type { DeliveredMessage, MessageEnvelope } from '../../shared/message-envelope'

export type Message = DeliveredMessage

export interface Conversation {
  address: string
  last_message_at: number
}

// Auth is a per-request dependency: every caller passes the bearer token for
// its own request. There is no shared module state to go stale on identity
// switch. `null` means "no session" (public or pre-auth endpoints).
async function request<T>(path: string, options: RequestInit, token: string | null): Promise<T> {
  const headers = new Headers(options.headers)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const res = await fetch(path, { ...options, headers })
  if (res.status === 401) {
    clearToken()
    // Trigger a page reload or state update to handle logout
    // but not for DELETE (logout already in progress) or auth endpoints
    if (!path.includes('/api/auth/') && !path.includes('/api/addresses/')) {
      window.dispatchEvent(new CustomEvent('auth:expired'))
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }

  if (res.status === 204) return {} as T
  return res.json()
}

export const api = {
  getRegChallenge: async (address: string, pubkey: string, token: string | null = null): Promise<{ challenge: string; nonce: string }> => {
    const normalizedAddress = address.toLowerCase()
    const normalizedPubkey = verifyEncryptionPublicKey(normalizedAddress, pubkey)
    const result = await request<{ challenge: string; nonce: string }>('/api/register/challenge', {
      method: 'POST',
      body: JSON.stringify({ address: normalizedAddress, pubkey: normalizedPubkey }),
      headers: { 'Content-Type': 'application/json' },
    }, token)
    const expected = buildRegistrationChallenge(
      window.location.origin,
      normalizedAddress,
      normalizedPubkey,
      result.nonce,
    )
    if (result.challenge !== expected) throw new Error('Invalid registration challenge')
    return result
  },

  register: (address: string, pubkey: string, signature: string, nonce: string, token: string | null = null) =>
    request('/api/register', {
      method: 'POST',
      body: JSON.stringify({ address, pubkey, signature, nonce }),
      headers: { 'Content-Type': 'application/json' },
    }, token),

  getPubkey: async (address: string, token: string | null = null): Promise<{ pubkey: string | null }> => {
    const result = await request<{ pubkey: string | null }>(`/api/pubkey/${address}`, {}, token)
    return {
      pubkey: result.pubkey === null ? null : verifyEncryptionPublicKey(address, result.pubkey),
    }
  },

  getChallenge: (address: string, token: string | null = null): Promise<{ challenge: string; nonce: string }> =>
    request('/api/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ address }),
      headers: { 'Content-Type': 'application/json' },
    }, token),

  createSession: (address: string, signature: string, nonce: string, token: string | null = null): Promise<{ token: string }> =>
    request('/api/auth/session', {
      method: 'POST',
      body: JSON.stringify({ address, signature, nonce }),
      headers: { 'Content-Type': 'application/json' },
    }, token),

  sendMessage: (data: MessageEnvelope, token: string | null = null): Promise<DeliveredMessage> =>
    request('/api/messages', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    }, token),

  getMessages: (address: string, token: string | null = null): Promise<{ messages: unknown[] }> =>
    request(`/api/messages/${address}`, {}, token),

  getConversations: (token: string | null = null): Promise<{ conversations: Conversation[] }> =>
    request('/api/conversations', {}, token),

  getSseToken: (token: string | null = null): Promise<{ sse_token: string }> =>
    request('/api/events/token', { method: 'POST' }, token),

  deleteAddress: (address: string, token: string | null = null) =>
    request(`/api/addresses/${address}`, { method: 'DELETE' }, token),

  getVapidPublicKey: (token: string | null = null): Promise<{ publicKey: string }> =>
    request('/api/push/vapid-public-key', {}, token),

  subscribePush: (subscription: PushSubscriptionJSON, token: string | null = null) =>
    request('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription),
      headers: { 'Content-Type': 'application/json' },
    }, token),

  unsubscribePush: (endpoint: string, token: string | null = null) =>
    request('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
      headers: { 'Content-Type': 'application/json' },
    }, token),
}
