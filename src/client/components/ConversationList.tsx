import { useState, useEffect, useRef } from 'preact/hooks'
import { MergedConversation } from '../hooks/useConversations'
import { getLastSeenKey } from '../lib/contacts'
import { Pencil, Trash2, Check } from 'lucide-preact'

interface ConversationListProps {
  conversations: MergedConversation[]
  activeAddress: string | null
  onSelect: (address: string) => void
  labels?: Record<string, string>
  onRename?: (address: string, name: string) => void
  onDelete?: (address: string) => void
}

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

export function ConversationList({ conversations, activeAddress, onSelect, labels = {}, onRename, onDelete }: ConversationListProps) {
  const [unreadMap, setUnreadMap] = useState<Record<string, boolean>>({})
  const [editingAddress, setEditingAddress] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  // The delete button is always visible on touch, right next to a tappable
  // row — so it takes two taps, same confirm pattern as logout.
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const confirmTimeoutRef = useRef<any>(null)

  useEffect(() => {
    return () => { if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current) }
  }, [])

  useEffect(() => {
    const map: Record<string, boolean> = {}
    for (const conv of conversations) {
      const addrLower = conv.address.toLowerCase()
      const key = getLastSeenKey(conv.address)
      // The active conversation is always considered read — any activity in
      // it (new message, sending, selecting) keeps last_seen current so the
      // dot never reappears while it's open.
      if (activeAddress?.toLowerCase() === addrLower) {
        localStorage.setItem(key, String(Date.now()))
        map[addrLower] = false
        continue
      }
      const lastSeen = localStorage.getItem(key)
      map[addrLower] = !lastSeen || Number(lastSeen) < conv.last_message_at
    }
    setUnreadMap(map)
  }, [conversations, activeAddress])

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

  const handleDelete = (e: Event, address: string) => {
    e.stopPropagation()
    const addr = address.toLowerCase()
    if (deleteConfirm === addr) {
      clearTimeout(confirmTimeoutRef.current)
      setDeleteConfirm(null)
      onDelete?.(address)
      return
    }
    setDeleteConfirm(addr)
    clearTimeout(confirmTimeoutRef.current)
    confirmTimeoutRef.current = setTimeout(() => setDeleteConfirm(null), 3000)
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
    <ul className="list-none m-0 p-0">
      {conversations.map((conv) => {
        const addr = conv.address.toLowerCase()
        const isActive = activeAddress?.toLowerCase() === addr
        const isUnread = unreadMap[addr]
        const isEditing = editingAddress === addr
        const isConfirming = deleteConfirm === addr
        const label = labels[addr]

        return (
          <li
            key={conv.address}
            className={`group flex items-center gap-1 pl-3 pr-1 py-1 border-b border-neutral-900 cursor-pointer select-none ${isActive ? 'bg-neutral-900' : ''} ${conv.stale ? 'opacity-50' : ''}`}
            title={conv.stale ? 'No active messages' : undefined}
            onClick={() => !isEditing && handleSelect(conv.address)}
          >
            {isEditing ? (
              <input
                className="flex-1"
                type="text"
                value={editValue}
                onInput={(e: any) => setEditValue(e.target.value)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === 'Enter') handleSaveEdit(addr)
                  else if (e.key === 'Escape') { setEditingAddress(null); setEditValue('') }
                }}
                onBlur={() => handleSaveEdit(addr)}
                onClick={(e) => e.stopPropagation()}
                autoFocus
              />
            ) : (
              <>
                <span className="flex-1 min-w-0 truncate">
                  {label || <span className="text-sm text-neutral-600">{conv.address.slice(0, 6)}...{conv.address.slice(-4)}</span>}
                </span>
                {isUnread && <span className="w-1.5 h-1.5 bg-white rounded-full shrink-0" aria-label="Unread" />}
                <time className="text-sm text-neutral-600 shrink-0">{formatTimestamp(conv.last_message_at)}</time>
                {/* Hidden-until-hover is a pointer-device affordance only; on
                    touch these stay visible or they'd be unreachable. */}
                <button onClick={(e) => handleStartEdit(e, conv.address)} title="Rename" aria-label="Rename" className="border-0 shrink-0 can-hover:opacity-0 can-hover:group-hover:opacity-100 focus:opacity-100">
                  <Pencil size={14} />
                </button>
                <button
                  onClick={(e) => handleDelete(e, conv.address)}
                  title={isConfirming ? 'Tap again to confirm' : 'Delete'}
                  aria-label={isConfirming ? 'Confirm delete' : 'Delete'}
                  className={`border-0 shrink-0 focus:opacity-100 ${isConfirming ? 'text-red-400' : 'can-hover:opacity-0 can-hover:group-hover:opacity-100'}`}
                >
                  {isConfirming ? <Check size={14} /> : <Trash2 size={14} />}
                </button>
              </>
            )}
          </li>
        )
      })}
    </ul>
  )
}
