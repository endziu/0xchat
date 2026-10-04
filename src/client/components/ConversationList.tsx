import { shortAddress, type Address } from '../../shared/address'
import { useState, useEffect, useRef } from 'preact/hooks'
import { UserX } from 'lucide-preact'
import { MergedConversation } from '../hooks/useConversations'
import { getLastSeenKey, subscribeLastSeen } from '../lib/contacts'
import { fmtDay, fmtTime } from '../lib/display'
import { AddressAvatar } from './AddressAvatar'
import { ErrorState } from './ErrorState'

interface ConversationListProps {
  conversations: MergedConversation[]
  activeAddress: Address | null
  onSelect: (address: Address) => void
  onNewConversation: () => void
  // Takes the conversation off the list and forgets its label, on this device.
  onRemove: (address: Address) => void
  labels?: Record<Address, string>
  error: string | null
  onRetry: () => void
}

export function ConversationList({ conversations, activeAddress, onSelect, onNewConversation, onRemove, labels = {}, error, onRetry }: ConversationListProps) {
  const [unreadMap, setUnreadMap] = useState<Record<string, boolean>>({})
  // Removing takes two taps; the second tap's question is spelled out, since
  // touch screens show no title.
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null)
  const removeConfirmTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(removeConfirmTimeout.current), [])

  const handleRemove = (e: Event, address: Address) => {
    e.stopPropagation()
    clearTimeout(removeConfirmTimeout.current)
    if (removeConfirm === address) {
      setRemoveConfirm(null)
      onRemove(address)
      return
    }
    setRemoveConfirm(address)
    removeConfirmTimeout.current = setTimeout(() => setRemoveConfirm(null), 3000)
  }

  // last_seen advances only when the open conversation confirms opening its
  // messages (or loads your own), so selecting a conversation in a hidden or
  // unfocused window leaves it unread.
  const [seenVersion, setSeenVersion] = useState(0)
  useEffect(() => subscribeLastSeen(() => setSeenVersion(version => version + 1)), [])

  useEffect(() => {
    const map: Record<string, boolean> = {}
    for (const conv of conversations) {
      const lastSeen = localStorage.getItem(getLastSeenKey(conv.address))
      map[conv.address] = !lastSeen || Number(lastSeen) < conv.last_message_at
    }
    setUnreadMap(map)
  }, [conversations, seenVersion])

  // The notice sits above the list rather than replacing it: a failed refresh
  // while cached contacts are on screen must not pass the stale list off as
  // live. An empty-but-successful load still gets the plain empty state.
  const errorNotice = error && <ErrorState title="Failed to load conversations" detail={error} onRetry={onRetry} />

  if (conversations.length === 0) {
    return errorNotice || (
      <div className="flex flex-col items-center justify-center gap-3 h-full p-4 text-center">
        <p className="m-0">No conversations yet</p>
        <p className="m-0 text-sm">Share your address with the copy, link or QR buttons at the top to start.</p>
        <button onClick={onNewConversation}>Start a conversation</button>
      </div>
    )
  }

  return (
    <>
      {errorNotice}
      <ul className="list-none m-0 p-0">
        {conversations.map((conv) => {
          const addr = conv.address
          const isActive = activeAddress === addr
          const isUnread = unreadMap[addr]
          const label = labels[addr]
          const confirming = removeConfirm === addr

          return (
            <li
              key={conv.address}
              className={`flex items-center gap-2 pl-1 pr-1 min-h-11 border-b border-neutral-900 cursor-pointer select-none ${isActive ? 'bg-neutral-900' : ''}`}
              onClick={() => onSelect(conv.address)}
            >
              {/* The unread dot owns the left edge, where the eye starts reading;
                  the slot is kept when read so the rows stay aligned. */}
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isUnread ? 'bg-accent' : ''}`} aria-label={isUnread ? 'Unread' : undefined} />
              <AddressAvatar address={conv.address} />
              <span className="flex-1 min-w-0 flex flex-col">
                <span className={`truncate ${isUnread ? 'font-bold text-white' : label ? 'text-neutral-300' : 'text-sm text-neutral-400'}`}>
                  {label || shortAddress(conv.address)}
                </span>
                {conv.stale && <span className="text-xs text-neutral-500">No messages</span>}
              </span>
              <time className={`text-sm shrink-0 ${isUnread ? 'text-neutral-200' : 'text-neutral-500'}`}>{fmtDay(conv.last_message_at) ?? fmtTime(conv.last_message_at)}</time>
              <button
                onClick={(e) => handleRemove(e, conv.address)}
                title="Remove from your conversations and forget the name"
                aria-label={confirming ? 'Confirm remove conversation' : 'Remove conversation'}
                className={`border-0 shrink-0 header-action ${confirming ? 'text-neutral-200' : 'text-neutral-500 hover:text-neutral-200'}`}
              >
                {confirming ? <span className="text-sm whitespace-nowrap">Remove and forget?</span> : <UserX size={14} />}
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
