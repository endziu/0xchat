import { useEffect, useState, useRef } from 'preact/hooks'
import { isWindowAttentive } from './useWindowAttention'
import { api } from '../lib/api'
import { SseConnection } from '../lib/sse-connection'

// Epochs are opaque identities: only equality has meaning to consumers.
export type ConnectionEpoch = symbol
export interface LiveConnection { current: ConnectionEpoch | null }

// Push suppression lapses 45 s after the last report of an attentive stream.
const ATTENTION_HEARTBEAT_MS = 20_000
const ATTENTION_SETTLE_MS = 300

export function useSSE(
  token: string | null,
  onMessage: (data: unknown) => void,
  onDisconnect?: (address: string) => void,
  onExpiryUpdate?: (data: unknown) => void,
) {
  const [connected, setConnected] = useState<ConnectionEpoch | null>(null)
  // Updated synchronously at the transport boundary, before Preact renders.
  const connection = useRef<ConnectionEpoch | null>(null)

  useEffect(() => {
    if (!token) {
      setConnected(null)
      return
    }
    const activeToken: string = token

    // The server only needs attention changes, plus a heartbeat while
    // attentive to outlive its TTL. Focus flips constantly on
    // focus-follows-pointer desktops, so changes are reported once settled.
    let streamToken: string | null = null
    let attentionSequence = 0
    let reported: boolean | null = null
    let dialedAttention = false
    let settle: ReturnType<typeof setTimeout> | undefined
    const sendAttention = (attentive: boolean) => {
      if (!streamToken) return
      const stream = streamToken
      reported = attentive
      void api.setSseAttention(activeToken, stream, attentive, ++attentionSequence).catch(() => {
        // Unknown to the server now; the next change or heartbeat resends.
        if (streamToken === stream && reported === attentive) reported = null
      })
    }
    const reportAttention = () => {
      clearTimeout(settle)
      settle = setTimeout(() => {
        const attentive = isWindowAttentive()
        if (attentive !== reported) sendAttention(attentive)
      }, ATTENTION_SETTLE_MS)
    }
    // EventSource alone cannot recover: a non-2xx response (cap 429, stale
    // token 401) ends it permanently, and its automatic retry of a dropped
    // stream re-dials a single-use token that now 401s. SseConnection drives
    // recovery with a fresh token and backoff on every failure.
    const conn = new SseConnection({
      getSseToken: async () => (await api.getSseToken(activeToken)).sse_token,
      buildUrl: (sseToken) => {
        dialedAttention = isWindowAttentive()
        return `/api/events?token=${sseToken}&attentive=${dialedAttention}`
      },
      onOpen: (sseToken) => {
        streamToken = sseToken
        attentionSequence = 0
        // The URL already told the server; report only a change since dialing.
        reported = dialedAttention
        reportAttention()
        connection.current = Symbol('SSE connection'); setConnected(connection.current)
      },
      onDisconnect: () => { streamToken = null; reported = null; connection.current = null; setConnected(null) },
      onMessage,
      onExpiryUpdate,
      onUserDisconnected: onDisconnect,
    })
    const update = () => {
      conn.setActive(document.visibilityState === 'visible')
      reportAttention()
    }
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    update()
    if (document.visibilityState === 'visible') conn.connect()
    const heartbeat = setInterval(() => {
      const attentive = isWindowAttentive()
      if (attentive || attentive !== reported) sendAttention(attentive)
    }, ATTENTION_HEARTBEAT_MS)

    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      clearInterval(heartbeat)
      clearTimeout(settle)
      streamToken = null
      connection.current = null
      conn.close()
      setConnected(null)
    }
  }, [token, onMessage, onDisconnect, onExpiryUpdate])

  return { connected: connected !== null, connection }
}
