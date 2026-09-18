import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import { api, Conversation } from '../lib/api'
import { mergeContacts, loadContacts, deleteContact, isDeleted } from '../lib/contacts'
import { errorMessage } from '../lib/errors'

export type ConversationRefreshResult = 'refreshed' | 'failed' | 'cancelled'

export interface MergedConversation extends Conversation {
  stale?: boolean
}

function withKnownContacts(live: Conversation[]): MergedConversation[] {
  const liveVisible = live.filter(c => !isDeleted(c.address, c.last_message_at))
  const known = mergeContacts(liveVisible)
  const liveAddresses = new Set(liveVisible.map(c => c.address.toLowerCase()))
  const stale = Object.values(known)
    .filter(c => !liveAddresses.has(c.address.toLowerCase()))
    .map(c => ({ address: c.address, last_message_at: c.last_message_at, stale: true }))
  return [...liveVisible, ...stale].sort((a, b) => b.last_message_at - a.last_message_at)
}

export function useConversations(token: string | null) {
  const [conversations, setConversations] = useState<MergedConversation[]>(() =>
    Object.values(loadContacts())
      .map(c => ({ ...c, stale: true }))
      .sort((a, b) => b.last_message_at - a.last_message_at)
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [labels, setLabels] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('conversation_labels') ?? '{}')
    } catch {
      return {}
    }
  })
  const debounceRef = useRef<NodeJS.Timeout | null>(null)
  const pendingRefreshRef = useRef(false)
  // Refreshes can overlap (token change, SSE, retry click). Only the newest one
  // is allowed to write state, so a slow failure can't clobber a newer success.
  const loadGenRef = useRef(0)
  const tokenRef = useRef(token)
  if (tokenRef.current !== token) {
    tokenRef.current = token
    loadGenRef.current++
  }

  const latestRefresh = useRef<Promise<ConversationRefreshResult> | null>(null)
  const doRefresh = useCallback((): Promise<ConversationRefreshResult> => {
    if (token !== tokenRef.current) return Promise.resolve('cancelled')
    const gen = ++loadGenRef.current
    if (!token) {
      setConversations([])
      setError(null)
      return Promise.resolve('cancelled')
    }
    setLoading(true)
    setError(null)
    // An awaited refresh follows its replacement, so an SSE refresh cannot
    // turn successful recovery into a failure just by finishing first.
    const superseded = (): Promise<ConversationRefreshResult> | ConversationRefreshResult =>
      token === tokenRef.current && latestRefresh.current ? latestRefresh.current : 'cancelled'
    const request = (async (): Promise<ConversationRefreshResult> => {
      try {
        const data = await api.getConversations(token)
        if (gen !== loadGenRef.current) return superseded()
        setConversations(withKnownContacts(data.conversations))
        return 'refreshed'
      } catch (err) {
        if (gen !== loadGenRef.current) return superseded()
        console.error('Failed to load conversations:', err)
        setError(errorMessage(err, 'Failed to load conversations'))
        return 'failed'
      } finally {
        if (gen === loadGenRef.current) setLoading(false)
      }
    })()
    latestRefresh.current = request
    return request
  }, [token])

  const setLabel = useCallback((address: string, name: string) => {
    setLabels(prev => {
      const next = { ...prev, [address.toLowerCase()]: name.trim() }
      if (!name.trim()) delete next[address.toLowerCase()]
      localStorage.setItem('conversation_labels', JSON.stringify(next))
      return next
    })
  }, [])

  const deleteConversation = useCallback((address: string) => {
    deleteContact(address)
    setLabels(prev => {
      const next = { ...prev }
      delete next[address.toLowerCase()]
      localStorage.setItem('conversation_labels', JSON.stringify(next))
      return next
    })
    setConversations(prev => prev.filter(c => c.address.toLowerCase() !== address.toLowerCase()))
  }, [])

  // Debounced: SSE can fire a burst of these. A retry click wants `reload`
  // instead, so it isn't deferred behind the 300 ms timer.
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
      loadGenRef.current++
      latestRefresh.current = null
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  return { conversations, loading, error, refresh, reload: doRefresh, labels, setLabel, deleteConversation }
}
