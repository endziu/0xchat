import { Conversation } from '../lib/api'

interface ConversationListProps {
  conversations: Conversation[]
  activeAddress: string | null
  onSelect: (address: string) => void
}

export function ConversationList({ conversations, activeAddress, onSelect }: ConversationListProps) {
  if (conversations.length === 0) {
    return (
      <div className="p-8 text-center text-dim italic text-sm">
        No active conversations
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {conversations.map((conv) => (
        <button
          key={conv.address}
          onClick={() => onSelect(conv.address)}
          className={`flex flex-col p-4 text-left border-b border-border hover:bg-surface transition-colors cursor-pointer ${
            activeAddress?.toLowerCase() === conv.address.toLowerCase() ? 'bg-surface border-l-2 border-l-accent' : ''
          }`}
        >
          <div className="text-sm font-mono truncate">
            {conv.address.slice(0, 10)}...{conv.address.slice(-8)}
          </div>
          <div className="flex justify-between items-center mt-1">
            <span className="text-[10px] text-dim opacity-60">
              {new Date(conv.last_message_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        </button>
      ))}
    </div>
  )
}
