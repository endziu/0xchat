import { useState, useEffect } from 'preact/hooks'
import { Conversation } from '../lib/api'
import { Pencil } from 'lucide-preact'

interface ConversationListProps {
  conversations: Conversation[]
  activeAddress: string | null
  onSelect: (address: string) => void
  labels?: Record<string, string>
  onRename?: (address: string, name: string) => void
}

const getLastSeenKey = (address: string) => `last_seen_${address.toLowerCase()}`

const formatTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const timeDiff = today.getTime() - msgDate.getTime()

  if (timeDiff === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  if (timeDiff === 86400000) return 'Yesterday'
  if (timeDiff < 604800000) return date.toLocaleDateString([], { weekday: 'short' })
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function ConversationList({ conversations, activeAddress, onSelect, labels = {}, onRename }: ConversationListProps) {
  const [unreadMap, setUnreadMap] = useState<Record<string, boolean>>({})
  const [editingAddress, setEditingAddress] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  useEffect(() => {
    const map: Record<string, boolean> = {}
    for (const conv of conversations) {
      const key = getLastSeenKey(conv.address)
      const lastSeen = localStorage.getItem(key)
      map[conv.address.toLowerCase()] = !lastSeen || Number(lastSeen) < conv.last_message_at
    }
    setUnreadMap(map)
  }, [conversations])

  const handleSelect = (address: string) => {
    localStorage.setItem(getLastSeenKey(address), String(Date.now()))
    setUnreadMap(prev => ({ ...prev, [address.toLowerCase()]: false }))
    onSelect(address)
  }

  const handleStartEdit = (e: Event, address: string) => {
    e.stopPropagation()
    setEditingAddress(address.toLowerCase())
    setEditValue(labels[address.toLowerCase()] ?? '')
  }

  const handleSaveEdit = (address: string) => {
    onRename?.(address, editValue)
    setEditingAddress(null)
    setEditValue('')
  }

  if (conversations.length === 0) {
    return <div className="flex items-center justify-center h-full text-neutral-700 p-4">No conversations yet</div>
  }

  return (
    <div>
      {conversations.map((conv) => {
        const addr = conv.address.toLowerCase()
        const isActive = activeAddress?.toLowerCase() === addr
        const isUnread = unreadMap[addr]
        const isEditing = editingAddress === addr
        const label = labels[addr]

        return (
          <button
            key={conv.address}
            className={`flex items-center w-full border-neutral-900 py-2 ${isActive ? 'bg-neutral-900' : ''}`}
            onClick={() => !isEditing && handleSelect(conv.address)}
          >
            {isEditing ? (
              <div className="flex-1" onClick={(e) => e.stopPropagation()}>
                <input
                  type="text"
                  value={editValue}
                  onInput={(e: any) => setEditValue(e.target.value)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter') handleSaveEdit(addr)
                    else if (e.key === 'Escape') { setEditingAddress(null); setEditValue('') }
                  }}
                  onBlur={() => handleSaveEdit(addr)}
                  autoFocus
                />
              </div>
            ) : (
              <>
                <div className="min-w-0">
                  {label ? label : <span className="text-sm text-neutral-600">{conv.address.slice(0, 5)}...{conv.address.slice(-3)}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={(e) => handleStartEdit(e, conv.address)} title="Rename" className="border-0 p-0.5 shrink-0">
                    <Pencil size={12} />
                  </button>
                  {isUnread && <div className="w-1.5 h-1.5 bg-white rounded-full shrink-0" aria-label="Unread" />}
                </div>
                <div>
                  <span className="text-sm text-neutral-600">{formatTimestamp(conv.last_message_at)}</span>
                </div>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}
