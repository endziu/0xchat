import type { Address } from '../../shared/address'
import { clearTokenIfMatches } from './session'
import { CLIENT_UPDATE_REQUIRED_CODE } from '../../shared/api-error'
import type { Keypair } from '../../shared/keypair'
import type { DeliveredMessage, MessageEnvelope } from '../../shared/message-envelope'
import { ProtocolClient, type ApiError } from '../../shared/protocol-client'

export { ApiError, type Conversation, type MessagePage, type RecoveryPage } from '../../shared/protocol-client'

export type Message = DeliveredMessage

/** Dispatched when the server requires a newer client; retrying cannot succeed. */
export const CLIENT_UPDATE_REQUIRED_EVENT = 'client:update-required'

function onError(error: ApiError, { path, token }: { path: string; token: string | null }): void {
  // Invalidate only the session that actually produced this token. A delayed
  // request carrying a previous identity's token must not clear (or sign out)
  // a newer session that has since been committed.
  if (error.status === 401 && token && clearTokenIfMatches(token)) {
    // Trigger a page reload or state update to handle logout
    // but not for DELETE (logout already in progress) or auth endpoints
    if (!path.includes('/api/auth/') && !path.includes('/api/addresses/')) {
      globalThis.dispatchEvent(new CustomEvent('auth:expired'))
    }
  }
  if (error.code === CLIENT_UPDATE_REQUIRED_CODE) globalThis.dispatchEvent(new CustomEvent(CLIENT_UPDATE_REQUIRED_EVENT))
}

// Created on first use: challenges are bound to the page's origin.
let client: ProtocolClient | null = null
function protocol(): ProtocolClient {
  return client ??= new ProtocolClient(window.location.origin, (path, init) => fetch(path, init), onError)
}

// Auth is a per-request dependency: every caller passes the bearer token for
// its own request. There is no shared module state to go stale on identity
// switch.
export const api = {
  // --- Public / pre-auth endpoints (no session required) ---

  register: (identity: Keypair) => protocol().register(identity),

  login: (identity: Keypair) => protocol().login(identity),

  getPubkey: async (address: Address): Promise<{ pubkey: string | null }> => ({ pubkey: await protocol().pubkey(address) }),

  getVapidPublicKey: (): Promise<{ publicKey: string }> =>
    protocol().request('/api/push/vapid-public-key'),

  // --- Authenticated endpoints (a session token is required) ---

  sendMessage: (identity: Keypair, envelope: MessageEnvelope, token: string) => protocol().send(identity, envelope, token),

  getMessages: (address: Address, token: string, beforeSeq?: number, limit?: number) =>
    protocol().history(address, token, { before: beforeSeq, limit }),

  recoverMessages: (address: Address, token: string, cursor: { after: string } | { cursor: string }) =>
    protocol().recover(address, token, cursor),

  // Opening starts message lifetimes; state lookup never does.
  openMessages: (address: Address, ids: string[], token: string) => protocol().open(address, ids, token),

  getMessageStates: (address: Address, ids: string[], token: string) => protocol().states(address, ids, token),

  clearConversation: (address: Address, token: string) => protocol().clear(address, token),

  getConversations: async (token: string) => ({ conversations: await protocol().conversations(token) }),

  getSseToken: (token: string) => protocol().sseToken(token),

  setSseAttention: (token: string, stream: string, attentive: boolean, sequence: number): Promise<unknown> =>
    protocol().request('/api/events/attention', { method: 'POST', body: { stream, attentive, sequence }, token, keepalive: true }),

  deleteSession: (token: string) => protocol().deleteSession(token),

  deleteAddress: (address: Address, token: string) => protocol().deleteAddress(address, token),

  subscribePush: (subscription: PushSubscriptionJSON, token: string) =>
    protocol().request('/api/push/subscribe', { method: 'POST', body: subscription, token }),

  unsubscribePush: (endpoint: string, token: string) =>
    protocol().request('/api/push/unsubscribe', { method: 'POST', body: { endpoint }, token }),
}
