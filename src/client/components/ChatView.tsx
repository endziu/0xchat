import { useState, useCallback, useRef, useEffect } from 'preact/hooks'
import { ConversationList } from './ConversationList'
import { MessagePane } from './MessagePane'
import { useConversations } from '../hooks/useConversations'
import { useMessages } from '../hooks/useMessages'
import { useSSE } from '../hooks/useSSE'
import { Keypair } from '../lib/burner'
import { api } from '../lib/api'
import { Plus, X } from 'lucide-preact'

interface ChatViewProps {
  recipientAddress: string | null
  identity: Keypair
  token: string
  navigate: (to: string) => void
  onConnectedChange?: (connected: boolean) => void
}

export function ChatView({ recipientAddress, identity, token, navigate, onConnectedChange }: ChatViewProps) {
  const { conversations, refresh: refreshConversations } = useConversations(token)
  const { messages, sendMessage, addMessage } = useMessages(recipientAddress, identity, token)
  const [newChatAddr, setNewChatAddr] = useState<string | null>(null)
  const [newChatError, setNewChatError] = useState('')
  const [disconnectNotice, setDisconnectNotice] = useState<string | null>(null)

  // Use refs to keep SSE handlers stable across conversation changes
  const handleSSERef = useRef((data: any) => {
    refreshConversations()
    if (recipientAddress && (
      data.sender.toLowerCase() === recipientAddress.toLowerCase() ||
      data.sender.toLowerCase() === identity.address.toLowerCase()
    )) {
      addMessage(data)
    }
  })

  const handleDisconnectRef = useRef((address: string) => {
    refreshConversations()
    if (recipientAddress?.toLowerCase() === address.toLowerCase()) {
      setDisconnectNotice(`${address.slice(0, 6)}...${address.slice(-4)} has left the chat`)
      setTimeout(() => navigate('/chat'), 2000)
    }
  })

  // Update refs when dependencies change, without triggering SSE reconnect
  useEffect(() => {
    handleSSERef.current = (data: any) => {
      refreshConversations()
      if (recipientAddress && (
        data.sender.toLowerCase() === recipientAddress.toLowerCase() ||
        data.sender.toLowerCase() === identity.address.toLowerCase()
      )) {
        addMessage(data)
      }
    }
  }, [recipientAddress, identity.address, refreshConversations, addMessage])

  useEffect(() => {
    handleDisconnectRef.current = (address: string) => {
      refreshConversations()
      if (recipientAddress?.toLowerCase() === address.toLowerCase()) {
        setDisconnectNotice(`${address.slice(0, 6)}...${address.slice(-4)} has left the chat`)
        setTimeout(() => navigate('/chat'), 2000)
      }
    }
  }, [recipientAddress, navigate, refreshConversations])

  // Create stable wrapper functions that call the updated refs
  const stableHandleSSE = useCallback((data: any) => handleSSERef.current(data), [])
  const stableHandleDisconnect = useCallback((address: string) => handleDisconnectRef.current(address), [])

  // Pass stable handlers to SSE with only token as dependency
  const { connected } = useSSE(token, stableHandleSSE, stableHandleDisconnect)

  // Notify parent of connection status
  useEffect(() => {
    onConnectedChange?.(connected)
  }, [connected, onConnectedChange])

  const handleNewChat = () => {
    setNewChatAddr('')
    setNewChatError('')
  }

  const handleNewChatSubmit = async () => {
    if (!newChatAddr) return
    if (!/^0x[0-9a-fA-F]{40}$/.test(newChatAddr)) {
      setNewChatError('Invalid address. Must be 0x followed by 40 hex characters.')
      return
    }

    // Pre-check if recipient is registered
    try {
      const { pubkey } = await api.getPubkey(newChatAddr)
      if (!pubkey) {
        setNewChatError('This address has not registered their encryption key yet.')
        return
      }
      navigate(`/chat/${newChatAddr.toLowerCase()}`)
      setNewChatAddr(null)
    } catch (err: any) {
      setNewChatError(err.message || 'Failed to check recipient registration.')
    }
  }

  const handleNewChatKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNewChatSubmit()
    } else if (e.key === 'Escape') {
      setNewChatAddr(null)
      setNewChatError('')
    }
  }

  return (
    <div className="flex h-full overflow-hidden relative">
      <div className={`w-80 border-r border-border flex flex-col shrink-0 ${recipientAddress ? 'hidden md:flex' : 'flex w-full'}`}>
        <div className="border-b border-border bg-surface/30">
          <div className="p-4 flex justify-between items-center">
            <span className="text-[10px] uppercase tracking-[0.2em] text-dim">Conversations</span>
            <button
              onClick={handleNewChat}
              className="p-1 text-accent hover:bg-accent hover:text-bg transition-colors border border-accent rounded-sm cursor-pointer"
            >
              <Plus size={14} />
            </button>
          </div>
          {newChatAddr !== null && (
            <div className="px-4 pb-4 flex flex-col gap-2">
              <input
                type="text"
                placeholder="0x..."
                value={newChatAddr}
                onInput={(e: any) => {
                  setNewChatAddr(e.target.value)
                  setNewChatError('')
                }}
                onKeyDown={handleNewChatKeyDown}
                autoFocus
                className="bg-surface border border-border rounded px-3 py-2 text-xs font-mono focus:outline-none focus:border-accent"
              />
              {newChatError && <p className="text-error text-xs">{newChatError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={handleNewChatSubmit}
                  className="flex-1 px-3 py-1.5 bg-accent text-bg rounded text-xs font-bold hover:opacity-90 transition-opacity cursor-pointer"
                >
                  Start Chat
                </button>
                <button
                  onClick={() => {
                    setNewChatAddr(null)
                    setNewChatError('')
                  }}
                  className="px-2 py-1.5 text-dim hover:text-accent transition-colors border border-border rounded cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}
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
        {disconnectNotice && (
          <div className="bg-error/20 border-b border-error/50 px-4 py-3 text-center text-sm text-error animate-pulse">
            {disconnectNotice}
          </div>
        )}
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
