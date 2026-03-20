import { useEffect } from 'preact/hooks'

export function useSSE(token: string | null, onMessage: (data: any) => void) {
  useEffect(() => {
    if (!token) return

    const es = new EventSource(`/api/events?token=${token}`)

    es.addEventListener('message', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        onMessage(data)
      } catch (err) {
        console.error('Failed to parse SSE message data:', err)
      }
    })

    es.onerror = (err) => {
      console.error('SSE error:', err)
      es.close()
    }

    return () => {
      es.close()
    }
  }, [token, onMessage])
}
