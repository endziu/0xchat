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

  if (timeDiff === 0) {
    // Today
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } else if (timeDiff === 86400000) {
    // Yesterday
    return 'Yesterday'
  } else if (timeDiff < 604800000) {
    // Less than a week
    return date.toLocaleDateString([], { weekday: 'short' })
  } else {
    // Older
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
}

export function ConversationList({ conversations, activeAddress, onSelect, labels = {}, onRename }: ConversationListProps) {
  const [unreadMap, setUnreadMap] = useState<Record<string, boolean>>({})
  const [editingAddress, setEditingAddress] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  useEffect(() => {
    // Initialize unread map based on localStorage
    const map: Record<string, boolean> = {}
    for (const conv of conversations) {
      const key = getLastSeenKey(conv.address)
      const lastSeen = localStorage.getItem(key)
      map[conv.address.toLowerCase()] = !lastSeen || Number(lastSeen) < conv.last_message_at
    }
    setUnreadMap(map)
  }, [conversations])

  const handleSelect = (address: string) => {
    // Mark as read
    const key = getLastSeenKey(address)
    localStorage.setItem(key, String(Date.now()))
    setUnreadMap(prev => ({ ...prev, [address.toLowerCase()]: false }))
    onSelect(address)
  }

  const handleStartEdit = (e: Event, address: string) => {
    e.stopPropagation()
    const currentName = labels[address.toLowerCase()] ?? ''
    setEditingAddress(address.toLowerCase())
    setEditValue(currentName)
  }

  const handleSaveEdit = (address: string) => {
    if (onRename) {
      onRename(address, editValue)
    }
    setEditingAddress(null)
    setEditValue('')
  }

  const handleCancelEdit = () => {
    setEditingAddress(null)
    setEditValue('')
  }

  if (conversations.length === 0) {
    return (
      <div className="p-8 text-center text-dim italic text-sm">
        No active conversations
        <br />
        Select a conversation or start a new one.
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {conversations.map((conv) => {
        const isActive = activeAddress?.toLowerCase() === conv.address.toLowerCase()
        const isUnread = unreadMap[conv.address.toLowerCase()]

        const isEditing = editingAddress === conv.address.toLowerCase()
        const label = labels[conv.address.toLowerCase()]

        return (
          <button
            key={conv.address}
            onClick={() => !isEditing && handleSelect(conv.address)}
            className={`flex flex-col p-4 text-left border-b border-border hover:bg-surface transition-colors cursor-pointer group ${
              isActive ? 'bg-surface border-l-2 border-l-accent' : ''
            }`}
          >
            {isEditing ? (
              <div className="flex items-center gap-2 mb-2" onClick={(e) => e.stopPropagation()}>
                <input
                  type="text"
                  value={editValue}
                  onInput={(e: any) => setEditValue(e.target.value)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter') {
                      handleSaveEdit(conv.address.toLowerCase())
                    } else if (e.key === 'Escape') {
                      handleCancelEdit()
                    }
                  }}
                  onBlur={() => handleSaveEdit(conv.address.toLowerCase())}
                  autoFocus
                  className="flex-1 text-sm font-mono px-2 py-1 bg-bg border border-accent rounded focus:outline-none"
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  {label ? (
                    <>
                      <div className="text-sm truncate font-medium text-text">{label}</div>
                      <div className="text-[10px] text-dim font-mono truncate">
                        {conv.address.slice(0, 10)}...{conv.address.slice(-8)}
                      </div>
                    </>
                  ) : (
                    <div className="text-sm font-mono truncate">
                      {conv.address.slice(0, 10)}...{conv.address.slice(-8)}
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => handleStartEdit(e, conv.address)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-dim hover:text-accent shrink-0"
                  title="Rename conversation"
                >
                  <Pencil size={14} />
                </button>
                {isUnread && (
                  <div className="w-2 h-2 rounded-full bg-accent shrink-0" aria-label="Unread" />
                )}
              </div>
            )}
            <div className="flex justify-between items-center mt-1">
              <span className="text-[10px] text-dim opacity-60">
                {formatTimestamp(conv.last_message_at)}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
