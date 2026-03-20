import { useState, useEffect } from 'preact/hooks'
import { api, Conversation } from '../lib/api'

export function useConversations(token: string | null) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(false)

  async function refresh() {
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
  }

  useEffect(() => {
    refresh()
  }, [token])

  return { conversations, loading, refresh }
}
