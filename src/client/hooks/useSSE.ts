import { useEffect, useState } from 'preact/hooks'
import { api } from '../lib/api'
import { SseConnection } from '../lib/sse-connection'

export function useSSE(
  token: string | null,
  onMessage: (data: unknown) => void,
  onDisconnect?: (address: string) => void,
  onExpiryUpdate?: (data: unknown) => void,
) {
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!token) {
      setConnected(false)
      return
    }
    const activeToken: string = token

    // EventSource alone cannot recover: a non-2xx response (cap 429, stale
    // token 401) ends it permanently, and its automatic retry of a dropped
    // stream re-dials a single-use token that now 401s. SseConnection drives
    // recovery with a fresh token and backoff on every failure.
    const conn = new SseConnection({
      getSseToken: async () => (await api.getSseToken(activeToken)).sse_token,
      buildUrl: (sseToken) => `/api/events?token=${sseToken}`,
      onOpen: () => setConnected(true),
      onDisconnect: () => setConnected(false),
      onMessage,
      onExpiryUpdate,
      onUserDisconnected: onDisconnect,
    })
    conn.connect()

    return () => {
      conn.close()
      setConnected(false)
    }
  }, [token, onMessage, onDisconnect, onExpiryUpdate])

  return { connected }
}
