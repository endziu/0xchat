import { getToken, clearToken } from './session'
import { buildRegistrationChallenge, verifyEncryptionPublicKey } from './encryption-key'
import type { DeliveredMessage, MessageEnvelope } from '../../shared/message-envelope'

export type Message = DeliveredMessage

export interface Conversation {
  address: string
  last_message_at: number
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
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
  getRegChallenge: async (address: string, pubkey: string): Promise<{ challenge: string; nonce: string }> => {
    const normalizedAddress = address.toLowerCase()
    const normalizedPubkey = verifyEncryptionPublicKey(normalizedAddress, pubkey)
    const result = await request<{ challenge: string; nonce: string }>('/api/register/challenge', {
      method: 'POST',
      body: JSON.stringify({ address: normalizedAddress, pubkey: normalizedPubkey }),
      headers: { 'Content-Type': 'application/json' },
    })
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
    }),

  getPubkey: async (address: string): Promise<{ pubkey: string | null }> => {
    const result = await request<{ pubkey: string | null }>(`/api/pubkey/${address}`)
    return {
      pubkey: result.pubkey === null ? null : verifyEncryptionPublicKey(address, result.pubkey),
    }
  },

  getChallenge: (address: string): Promise<{ challenge: string; nonce: string }> =>
    request('/api/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ address }),
      headers: { 'Content-Type': 'application/json' },
    }),

  createSession: (address: string, signature: string, nonce: string): Promise<{ token: string }> =>
    request('/api/auth/session', {
      method: 'POST',
      body: JSON.stringify({ address, signature, nonce }),
      headers: { 'Content-Type': 'application/json' },
    }),

  sendMessage: (data: MessageEnvelope): Promise<DeliveredMessage> =>
    request('/api/messages', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    }),

  getMessages: (address: string): Promise<{ messages: unknown[] }> =>
    request(`/api/messages/${address}`),

  getConversations: (): Promise<{ conversations: Conversation[] }> =>
    request('/api/conversations'),

  getSseToken: (): Promise<{ sse_token: string }> =>
    request('/api/events/token', { method: 'POST' }),

  deleteAddress: (address: string) =>
    request(`/api/addresses/${address}`, { method: 'DELETE' }),

  getVapidPublicKey: (): Promise<{ publicKey: string }> =>
    request('/api/push/vapid-public-key'),

  subscribePush: (subscription: PushSubscriptionJSON) =>
    request('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription),
      headers: { 'Content-Type': 'application/json' },
    }),

  unsubscribePush: (endpoint: string) =>
    request('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
      headers: { 'Content-Type': 'application/json' },
    }),
}
