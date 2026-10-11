import { shortAddress, type Address } from '../../shared/address'
import { useState, useEffect, useRef } from 'preact/hooks'
import { QrCode, X } from 'lucide-preact'
import { MergedConversation } from '../hooks/useConversations'
import { getLastSeenKey, subscribeLastSeen } from '../lib/contacts'
import { fmtDay, fmtTime } from '../lib/display'
import { AddressAvatar } from './AddressAvatar'
import { ErrorState } from './ErrorState'

interface ConversationListProps {
  conversations: MergedConversation[]
  activeAddress: Address | null
  selfAddress: Address
  onSelect: (address: Address) => void
  onNewConversation: () => void
  onShare: () => void
  // Takes the conversation off the list and forgets its label, on this device.
  onRemove: (address: Address) => void
  labels?: Record<Address, string>
  error: string | null
  onRetry: () => void
}

export function ConversationList({ conversations, activeAddress, selfAddress, onSelect, onNewConversation, onShare, onRemove, labels = {}, error, onRetry }: ConversationListProps) {
  const [unreadMap, setUnreadMap] = useState<Record<string, boolean>>({})
  // Removing takes two taps; the second tap's button says what it does, since
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
      <div className="m-auto grid max-w-[34ch] justify-items-center gap-3 px-7 pt-6 pb-12 text-center">
        <AddressAvatar address={selfAddress} size={64} />
        <h2 className="mt-1.5 text-lg font-bold">No conversations yet</h2>
        <p className="mb-2 text-text-2">Share your address or QR code. When someone writes to you, they’ll show up here.</p>
        <button onClick={onShare} className="btn btn-accent btn-lg"><QrCode size={18} />Share your address</button>
        <button onClick={onNewConversation} className="btn btn-lg">Start a conversation</button>
      </div>
    )
  }

  return (
    <>
      {errorNotice}
      <ul className="m-0 list-none p-0">
        {conversations.map((conv) => {
          const addr = conv.address
          const isActive = activeAddress === addr
          const isUnread = unreadMap[addr]
          const label = labels[addr]
          const confirming = removeConfirm === addr

          return (
            <li
              key={conv.address}
              className={`group grid cursor-pointer select-none grid-cols-[46px_1fr_auto_auto] items-center gap-3 rounded-md py-2.5 pr-1 pl-3 ${isActive ? 'bg-raised' : 'hover:bg-raised/55'}`}
              onClick={() => onSelect(conv.address)}
            >
              <AddressAvatar address={conv.address} size={46} />
              <span className="grid min-w-0 leading-tight">
                <span className={`truncate ${isUnread ? 'font-extrabold' : 'font-semibold'} ${label ? '' : 'font-mono'}`}>
                  {label || shortAddress(conv.address)}
                </span>
                <span className="truncate text-sm text-text-3">
                  {conv.stale ? 'No messages' : label ? <span className="font-mono">{shortAddress(conv.address)}</span> : 'No name yet'}
                </span>
              </span>
              <span className="grid justify-items-end gap-1.5 text-xs">
                <time className={isUnread ? 'font-bold text-accent-text' : 'text-text-3'}>{fmtDay(conv.last_message_at) ?? fmtTime(conv.last_message_at)}</time>
                {isUnread && <span className="size-2.5 rounded-full bg-accent" aria-label="Unread" />}
              </span>
              <button
                onClick={(e) => handleRemove(e, conv.address)}
                title="Remove from your conversations and forget the name"
                aria-label={confirming ? 'Confirm remove conversation' : 'Remove conversation'}
                className={confirming ? 'btn btn-danger btn-sm' : 'icon-btn size-10 text-text-3 can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:focus-visible:opacity-100'}
              >
                {confirming ? 'Remove' : <X size={18} />}
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
