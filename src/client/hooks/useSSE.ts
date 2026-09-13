import { useEffect, useState, useRef } from 'preact/hooks'
import { isWindowAttentive } from './useWindowAttention'
import { api } from '../lib/api'
import { SseConnection } from '../lib/sse-connection'

export function useSSE(
  token: string | null,
  onMessage: (data: unknown) => void,
  onDisconnect?: (address: string) => void,
  onExpiryUpdate?: (data: unknown) => void,
) {
  const [connected, setConnected] = useState(0)
  // Updated synchronously at the transport boundary, before Preact renders.
  const connection = useRef(0)
  const serial = useRef(0)

  useEffect(() => {
    if (!token) {
      setConnected(0)
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
      onOpen: () => { connection.current = ++serial.current; setConnected(connection.current) },
      onDisconnect: () => { connection.current = 0; setConnected(0) },
      onMessage,
      onExpiryUpdate,
      onUserDisconnected: onDisconnect,
    })
    const update = () => conn.setActive(isWindowAttentive())
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    update()
    if (isWindowAttentive()) conn.connect()

    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      connection.current = 0
      conn.close()
      setConnected(0)
    }
  }, [token, onMessage, onDisconnect, onExpiryUpdate])

  return { connected: connected !== 0, connection }
}
