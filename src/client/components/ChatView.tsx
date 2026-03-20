import { useState, useCallback } from 'preact/hooks'
import { ConversationList } from './ConversationList'
import { MessagePane } from './MessagePane'
import { useConversations } from '../hooks/useConversations'
import { useMessages } from '../hooks/useMessages'
import { useSSE } from '../hooks/useSSE'
import { Keypair } from '../lib/burner'
import { Plus } from 'lucide-preact'

interface ChatViewProps {
  recipientAddress: string | null
  identity: Keypair
  token: string
  navigate: (to: string) => void
}

export function ChatView({ recipientAddress, identity, token, navigate }: ChatViewProps) {
  const { conversations, refresh: refreshConversations } = useConversations(token)
  const { messages, sendMessage, refresh: refreshMessages } = useMessages(recipientAddress, identity, token)

  const handleSSE = useCallback((data: any) => {
    refreshConversations()
    if (recipientAddress && (
      data.sender.toLowerCase() === recipientAddress.toLowerCase() || 
      data.sender.toLowerCase() === identity.address.toLowerCase()
    )) {
      refreshMessages()
    }
  }, [recipientAddress, identity.address, refreshConversations, refreshMessages])

  useSSE(token, handleSSE)

  const handleNewChat = () => {
    const addr = prompt('Enter Ethereum address:')
    if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) {
      navigate(`/chat/${addr.toLowerCase()}`)
    } else if (addr) {
      alert('Invalid address')
    }
  }

  return (
    <div className="flex h-full overflow-hidden relative">
      <div className={`w-80 border-r border-border flex flex-col shrink-0 ${recipientAddress ? 'hidden md:flex' : 'flex w-full'}`}>
        <div className="p-4 border-b border-border flex justify-between items-center bg-surface/30">
          <span className="text-[10px] uppercase tracking-[0.2em] text-dim">Conversations</span>
          <button 
            onClick={handleNewChat}
            className="p-1 text-accent hover:bg-accent hover:text-bg transition-colors border border-accent rounded-sm cursor-pointer"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <ConversationList 
            conversations={conversations} 
            activeAddress={recipientAddress} 
            onSelect={(addr) => navigate(`/chat/${addr}`)}
          />
        </div>
      </div>

      <div className={`flex-1 flex flex-col min-w-0 ${!recipientAddress ? 'hidden md:flex items-center justify-center text-dim italic' : 'flex'}`}>
        {recipientAddress ? (
          <MessagePane 
            recipientAddress={recipientAddress}
            messages={messages}
            onSendMessage={sendMessage}
            onBack={() => navigate('/chat')}
          />
        ) : (
          <div className="text-sm font-serif italic opacity-50">Select a conversation or start a new one</div>
        )}
      </div>
    </div>
  )
}
