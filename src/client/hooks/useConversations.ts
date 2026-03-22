import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import { api, Conversation } from '../lib/api'

export function useConversations(token: string | null) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)
  const pendingRefreshRef = useRef(false)

  const doRefresh = useCallback(async () => {
    if (!token) {
      setConversations([])
      return
    }
    setLoading(true)
    try {
      const data = await api.getConversations()
      setConversations(data.conversations)
    } catch (err) {
      console.error('Failed to load conversations:', err)
    } finally {
      setLoading(false)
    }
  }, [token])

  const refresh = useCallback(() => {
    // Clear pending flag since we're scheduling a new one
    pendingRefreshRef.current = true

    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    debounceRef.current = setTimeout(() => {
      if (pendingRefreshRef.current) {
        doRefresh()
        pendingRefreshRef.current = false
      }
    }, 300)
  }, [doRefresh])

  useEffect(() => {
    doRefresh()
  }, [token, doRefresh])

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  return { conversations, loading, refresh }
}
