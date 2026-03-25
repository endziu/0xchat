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
  const { conversations, refresh: refreshConversations, labels, setLabel } = useConversations(token)
  const { messages, sendMessage, addMessage } = useMessages(recipientAddress, identity, token)
  const [newChatAddr, setNewChatAddr] = useState<string | null>(null)
  const [newChatError, setNewChatError] = useState('')
  const [disconnectNotice, setDisconnectNotice] = useState<string | null>(null)

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

  const stableHandleSSE = useCallback((data: any) => handleSSERef.current(data), [])
  const stableHandleDisconnect = useCallback((address: string) => handleDisconnectRef.current(address), [])
  const { connected } = useSSE(token, stableHandleSSE, stableHandleDisconnect)

  useEffect(() => { onConnectedChange?.(connected) }, [connected, onConnectedChange])

  const handleNewChatSubmit = async () => {
    if (!newChatAddr) return
    if (!/^0x[0-9a-fA-F]{40}$/.test(newChatAddr)) {
      setNewChatError('Invalid address. Must be 0x followed by 40 hex characters.')
      return
    }
    try {
      const { pubkey } = await api.getPubkey(newChatAddr)
      if (!pubkey) { setNewChatError('Address not registered yet.'); return }
      navigate(`/chat/${newChatAddr.toLowerCase()}`)
      setNewChatAddr(null)
    } catch (err: any) {
      setNewChatError(err.message || 'Failed to check registration.')
    }
  }

  return (
    <div className={`flex flex-1 overflow-hidden max-sm:flex-col ${recipientAddress ? 'max-sm:[&>:first-child]:hidden' : 'max-sm:[&>:last-child]:hidden'}`}>
      <nav className="w-72 shrink-0 border-r border-neutral-800 flex flex-col max-sm:w-full">
        <div className="flex items-center justify-between p-2 border-b border-neutral-800">
          <span className="text-sm uppercase tracking-wider text-neutral-500">Conversations</span>
          <button onClick={() => { setNewChatAddr(''); setNewChatError('') }} className="border-0 p-1"><Plus size={16} /></button>
        </div>
        {newChatAddr !== null && (
          <div className="p-2 border-b border-neutral-900 flex flex-col gap-1.5">
            <input
              type="text"
              placeholder="0x..."
              value={newChatAddr}
              onInput={(e: any) => { setNewChatAddr(e.target.value); setNewChatError('') }}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') handleNewChatSubmit()
                else if (e.key === 'Escape') { setNewChatAddr(null); setNewChatError('') }
              }}
              autoFocus
            />
            {newChatError && <p className="text-red-400">{newChatError}</p>}
            <div className="flex gap-1">
              <button onClick={handleNewChatSubmit}>Start</button>
              <button onClick={() => { setNewChatAddr(null); setNewChatError('') }}><X size={14} /></button>
            </div>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          <ConversationList
            conversations={conversations}
            activeAddress={recipientAddress}
            onSelect={(addr) => navigate(`/chat/${addr}`)}
            labels={labels}
            onRename={setLabel}
          />
        </div>
      </nav>

      <div className="flex-1 flex flex-col min-w-0">
        {disconnectNotice && <p className="p-2 border-b border-neutral-800 text-neutral-500 text-center">{disconnectNotice}</p>}
        {recipientAddress ? (
          <MessagePane
            recipientAddress={recipientAddress}
            messages={messages}
            onSendMessage={sendMessage}
            onBack={() => navigate('/chat')}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-neutral-700">No conversation selected</div>
        )}
      </div>
    </div>
  )
}
