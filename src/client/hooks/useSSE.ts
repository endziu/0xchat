import { useEffect, useState, useRef } from 'preact/hooks'
import { isWindowAttentive } from './useWindowAttention'
import { api } from '../lib/api'
import { SseConnection } from '../lib/sse-connection'

// Epochs are opaque identities: only equality has meaning to consumers.
export type ConnectionEpoch = symbol
export interface LiveConnection { current: ConnectionEpoch | null }

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

    // EventSource alone cannot recover: a non-2xx response (cap 429, stale
    // token 401) ends it permanently, and its automatic retry of a dropped
    // stream re-dials a single-use token that now 401s. SseConnection drives
    // recovery with a fresh token and backoff on every failure.
    let streamToken: string | null = null
    let attentionSequence = 0
    const reportAttention = () => {
      if (!streamToken) return
      void api.setSseAttention(activeToken, streamToken, isWindowAttentive(), ++attentionSequence).catch(() => {})
    }
    const conn = new SseConnection({
      getSseToken: async () => (await api.getSseToken(activeToken)).sse_token,
      buildUrl: (sseToken) => `/api/events?token=${sseToken}&attentive=${isWindowAttentive()}`,
      onOpen: (sseToken) => {
        streamToken = sseToken
        attentionSequence = 0
        reportAttention()
        connection.current = Symbol('SSE connection'); setConnected(connection.current)
      },
      onDisconnect: () => { streamToken = null; connection.current = null; setConnected(null) },
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
    const heartbeat = setInterval(reportAttention, 20_000)

    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      clearInterval(heartbeat)
      streamToken = null
      connection.current = null
      conn.close()
      setConnected(null)
    }
  }, [token, onMessage, onDisconnect, onExpiryUpdate])

  return { connected: connected !== null, connection }
}
