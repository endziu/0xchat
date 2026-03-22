import { useEffect, useState } from 'preact/hooks'
import { api } from '../lib/api'

export function useSSE(token: string | null, onMessage: (data: any) => void, onDisconnect?: (address: string) => void) {
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!token) {
      setConnected(false)
      return
    }

    let es: EventSource | null = null
    let mounted = true
    let reconnectTimeout: NodeJS.Timeout | null = null

    const setupSSE = async () => {
      try {
        // Get a short-lived SSE token
        const { sse_token } = await api.getSseToken()
        if (!mounted) return

        es = new EventSource(`/api/events?token=${sse_token}`)

        es.addEventListener('open', () => {
          if (mounted) setConnected(true)
        })

        es.addEventListener('message', (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            onMessage(data)
          } catch (err) {
            console.error('Failed to parse SSE message data:', err)
          }
        })

        es.addEventListener('user:disconnected', (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            onDisconnect?.(data.address)
          } catch (err) {
            console.error('Failed to parse disconnect event:', err)
          }
        })

        es.onerror = (err) => {
          console.error('SSE error:', err)
          if (mounted) setConnected(false)
          // Let EventSource reconnect automatically
        }
      } catch (err) {
        console.error('Failed to get SSE token:', err)
        if (mounted) setConnected(false)
      }
    }

    setupSSE()

    return () => {
      mounted = false
      if (es) {
        es.close()
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout)
      }
      setConnected(false)
    }
  }, [token, onMessage, onDisconnect])

  return { connected }
}
