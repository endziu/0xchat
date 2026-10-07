import type { Address } from '../../shared/address'
import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'preact/hooks'
import { api } from '../lib/api'
import type { ConversationRefreshResult } from './useConversations'
import type { LiveConnection } from './useSSE'
import { Keypair } from '../../shared/keypair'
import { openMessage, sealMessage } from '../../shared/protocol-client'
import { errorMessage } from '../lib/errors'
import { markConversationSeen } from '../lib/contacts'
import type { DecryptedMessage } from '../lib/conversation-messages'
import { ConversationSession, type ConversationProtocol, type SessionSnapshot } from '../lib/conversation-session'
import type { ConnectionEpoch } from '../lib/sse-connection'
import { isWindowAttentive, watchWindowAttention } from '../lib/window-attention'
import type { LiveEvent } from '../../shared/live-events'

const NO_CONVERSATION: SessionSnapshot = {
  messages: [], now: () => Date.now(), recovering: true, loading: false, error: null, olderError: null,
  hasMore: false, loadingOlder: false, openingFailed: false, recipientPubkey: null, seenThrough: null,
}

function apiProtocol(identity: Keypair, partner: Address, token: string, refreshConversations: () => Promise<ConversationRefreshResult>): ConversationProtocol {
  return {
    partnerPubkey: async () => (await api.getPubkey(partner)).pubkey,
    history: (limit, before) => api.getMessages(partner, token, before, limit),
    recover: cursor => api.recoverMessages(partner, token, cursor),
    states: ids => api.getMessageStates(partner, ids, token),
    open: ids => api.openMessages(partner, ids, token),
    clear: () => api.clearConversation(partner, token),
    refreshConversations: async () => await refreshConversations() === 'refreshed',
    send: async (plaintext, ttl, partnerPubkey) => {
      const envelope = await sealMessage(identity, partner, partnerPubkey, plaintext, ttl)
      try {
        return await api.sendMessage(identity, envelope, token)
      } catch (err) {
        throw new Error(errorMessage(err, 'Server rejected the message'))
      }
    },
  }
}

export function decryptFor(identity: Keypair, partner: Address) {
  return async (input: unknown): Promise<DecryptedMessage | null> => {
    // Live events from other conversations share the stream. Skip them before
    // signature verification; matching raw participants does not establish trust.
    if (typeof input !== 'object' || input === null) return null
    const raw = input as { sender?: unknown; recipient?: unknown }
    if (raw.sender !== partner && raw.recipient !== partner) return null
    try {
      return await openMessage(identity, input, partner)
    } catch (err) {
      console.error('Rejected message envelope:', err)
      return null
    }
  }
}

/**
 * Messages of the selected conversation, kept by one ConversationSession per
 * identity, conversation partner and session token. `connection` gives the
 * live stream's epoch when a session starts; the stream reports later
 * changes through the returned `connectionChanged`, and its events through
 * `liveEvent`.
 */
export function useMessages(recipientAddress: Address | null, identity: Keypair | null, token: string | null, connection: LiveConnection, refreshConversations: () => Promise<ConversationRefreshResult>) {
  const [, setVersion] = useState(0)
  const rerender = useCallback(() => setVersion(version => version + 1), [])
  // Chosen during render, so a previous conversation's or identity's messages
  // never render, not even for one frame; disposing the previous session
  // makes its in-flight work ignored.
  const scope = `${identity?.address ?? ''}:${recipientAddress ?? ''}:${token ?? ''}`
  const selected = useRef<{ scope: string; token: string | null; session: ConversationSession | null } | null>(null)
  if (selected.current?.scope !== scope) {
    const previous = selected.current
    previous?.session?.dispose()
    selected.current = {
      scope,
      token,
      session: recipientAddress && identity && token ? new ConversationSession({
        self: identity.address,
        partner: recipientAddress,
        protocol: apiProtocol(identity, recipientAddress, token, refreshConversations),
        decrypt: decryptFor(identity, recipientAddress),
        // The stream belongs to the session token, and closes after this
        // render when that changes; the new token's stream reports itself.
        connection: previous?.token === token ? connection.current : null,
        attentive: isWindowAttentive(),
      }) : null,
    }
  }
  const session = selected.current.session
  const snapshot = session?.snapshot() ?? NO_CONVERSATION

  useLayoutEffect(() => {
    if (!session) return
    const unsubscribe = session.subscribe(rerender)
    if (session.snapshot() !== snapshot) rerender()
    return unsubscribe
  }, [session, rerender])

  useEffect(() => () => selected.current?.session?.dispose(), [])

  useLayoutEffect(() => watchWindowAttention(attentive => selected.current?.session?.attentionChanged(attentive)), [])

  const connectionChanged = useCallback((epoch: ConnectionEpoch | null) => selected.current?.session?.connectionChanged(epoch), [])
  const liveEvent = useCallback((event: LiveEvent) => selected.current?.session?.liveEvent(event), [])

  useEffect(() => {
    if (recipientAddress && snapshot.seenThrough !== null) markConversationSeen(recipientAddress, snapshot.seenThrough)
  })

  return {
    ...snapshot,
    fetchOlder: () => session?.fetchOlder() ?? Promise.resolve(),
    sendMessage: (plaintext: string, ttl: number) => session
      ? session.send(plaintext, ttl)
      : Promise.reject(new Error('Not ready to send message (missing identity or session)')),
    clearConversation: () => session ? session.clear() : Promise.reject(new Error('Not ready to clear the conversation')),
    refresh: () => session?.retry(),
    retryOpening: () => session?.retryOpening(),
    connectionChanged,
    liveEvent,
  }
}
