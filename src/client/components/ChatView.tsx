import { checksumAddress, parseAddress, type Address } from '../../shared/address'
import { conversationPath } from '../lib/address-links'
import { useState, useEffect, useRef } from 'preact/hooks'
import { ConversationList } from './ConversationList'
import { MessagePane } from './MessagePane'
import { useConversations } from '../hooks/useConversations'
import { useMessages } from '../hooks/useMessages'
import { useSSE } from '../hooks/useSSE'
import { useLatest } from '../hooks/useLatest'
import { reloadForUpdate, useClientUpdateRequired } from '../hooks/useClientUpdate'
import { Keypair } from '../lib/burner'
import { api } from '../lib/api'
import { markConversationSeen } from '../lib/contacts'
import type { ConnectionEpoch } from '../lib/sse-connection'
import type { LiveEvent } from '../../shared/live-events'
import { Plus, X, QrCode } from 'lucide-preact'
import { QRModal } from './QRModal'

interface ChatViewProps {
  recipientAddress: Address | null
  identity: Keypair
  token: string
  navigate: (to: string) => void
  onConnectedChange?: (connected: boolean) => void
}

export function ChatView({ recipientAddress, identity, token, navigate, onConnectedChange }: ChatViewProps) {
  const { conversations, refresh: refreshConversations, reload: reloadConversations, error: conversationsError, labels, setLabel, removeConversation } = useConversations(token)
  const [newChatAddr, setNewChatAddr] = useState<string | null>(null)
  const [newChatName, setNewChatName] = useState('')
  const [newChatError, setNewChatError] = useState('')
  const newChatInputRef = useRef<HTMLInputElement>(null)
  // Partners who burned their identity this session: nothing can reach them.
  const [departed, setDeparted] = useState<ReadonlySet<Address>>(new Set())
  const [showScanner, setShowScanner] = useState(false)

  // Not the stream's own disconnect: the partner deleted their registration,
  // so nothing can reach them.
  const handlePartnerRegistrationDeleted = (address: Address) => {
    refreshConversations()
    setDeparted(prev => new Set(prev).add(address))
  }

  // The stream comes before the message hook, whose synchronization depends
  // on it; these handlers call the message hook's latest functions.
  const handleConnectionChange = useLatest((epoch: ConnectionEpoch | null) => connectionChanged(epoch))
  const handleLiveEvent = useLatest((event: LiveEvent) => {
    switch (event.type) {
      case 'message': {
        refreshConversations()
        // A departed partner who writes again has imported their key again.
        const { sender } = event.data
        if (departed.has(sender)) setDeparted(prev => { const next = new Set(prev); next.delete(sender); return next })
        liveEvent(event)
        return
      }
      case 'expiry-update':
        liveEvent(event)
        return
      // Nothing is left to read in a cleared conversation, open or not.
      case 'conversation-cleared':
        markConversationSeen(event.data.address, event.data.cleared_at)
        refreshConversations()
        liveEvent(event)
        return
      case 'user:disconnected':
        handlePartnerRegistrationDeleted(event.data.address)
        return
      default:
        return event satisfies never
    }
  })

  // Reconnecting cannot succeed once the server requires a newer client.
  const updateRequired = useClientUpdateRequired()
  const { connected, connection } = useSSE(updateRequired ? null : token, handleLiveEvent, handleConnectionChange)
  const { messages, now, recovering, sendMessage, liveEvent, connectionChanged, clearConversation, loading: messagesLoading, error: messagesError, olderError: messagesOlderError, refresh: refreshMessages, hasMore, loadingOlder, fetchOlder, openingFailed, retryOpening } = useMessages(recipientAddress, identity, token, connection, reloadConversations)

  useEffect(() => { onConnectedChange?.(connected) }, [connected, onConnectedChange])

  const handleClearConversation = async () => {
    if (!recipientAddress) return
    const clearedAt = await clearConversation()
    markConversationSeen(recipientAddress, clearedAt)
    refreshConversations()
  }

  const handleRemoveConversation = (address: Address) => {
    removeConversation(address)
    if (recipientAddress === address) navigate('/chat')
  }

  const openNewChat = () => { setNewChatAddr(''); setNewChatName(''); setNewChatError('') }
  const closeNewChat = () => { setNewChatAddr(null); setNewChatError('') }
  // autoFocus loses to the + button, which keeps focus after the click.
  const newChatOpen = newChatAddr !== null
  useEffect(() => { if (newChatOpen) newChatInputRef.current?.focus() }, [newChatOpen])

  const resolveAndNavigate = async (input: string) => {
    const addr = parseAddress(input.trim())
    if (!addr) {
      setNewChatError('Invalid address. Must be 0x followed by 40 hex characters.')
      return
    }
    try {
      const { pubkey } = await api.getPubkey(addr)
      if (!pubkey) { setNewChatError('Address not registered yet.'); return }
      if (newChatName.trim()) setLabel(addr, newChatName)
      navigate(conversationPath(addr))
      setNewChatAddr(null)
    } catch (err: any) {
      setNewChatError(err.message || 'Failed to check registration.')
    }
  }

  const handleNewChatSubmit = () => {
    if (!newChatAddr) return
    resolveAndNavigate(newChatAddr)
  }

  const handleNewChatKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') handleNewChatSubmit()
    else if (e.key === 'Escape') closeNewChat()
  }

  const handleScan = (addr: Address) => {
    setShowScanner(false)
    setNewChatAddr(checksumAddress(addr))
    resolveAndNavigate(addr)
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden min-h-0">
      {/* Outside the responsive row, which hides one pane on small screens. */}
      {updateRequired && (
        <div role="alert" className="p-2 border-b border-neutral-800 flex items-center justify-center gap-2 text-red-400">
          <span>0xChat has been updated. Reload to keep chatting.</span>
          <button onClick={() => void reloadForUpdate()}>Reload to update</button>
        </div>
      )}
      <div className={`flex flex-1 min-h-0 overflow-hidden max-sm:flex-col ${recipientAddress ? 'max-sm:[&>:first-child]:hidden' : 'max-sm:[&>:last-child]:hidden'}`}>
        <nav className="w-72 shrink-0 border-r border-neutral-800 max-sm:border-r-0 flex flex-col max-sm:w-full max-sm:flex-1 max-sm:min-h-0">
          {/* Same sizing as MessagePane's header so the two bottom borders line up side by side. */}
          <div className="flex items-center justify-between min-h-11 sm:h-14 px-2 border-b border-neutral-800">
            <span className="text-sm uppercase tracking-wider text-neutral-500">Conversations</span>
            <button onClick={openNewChat} aria-label="New conversation" title="New conversation" className="border-0"><Plus size={18} /></button>
          </div>
          {newChatAddr !== null && (
            <div className="p-2 border-b border-neutral-900 flex flex-col gap-1.5">
              <input
                ref={newChatInputRef}
                type="text"
                aria-label="Address"
                placeholder="0x..."
                autocomplete="off"
                autocorrect="off"
                autocapitalize="none"
                spellcheck={false}
                value={newChatAddr}
                onInput={(e: any) => { setNewChatAddr(e.target.value); setNewChatError('') }}
                onKeyDown={handleNewChatKeyDown}
              />
              <input
                type="text"
                aria-label="Name (optional)"
                placeholder="Name (optional)"
                autocomplete="off"
                maxLength={64}
                value={newChatName}
                onInput={(e: any) => setNewChatName(e.target.value)}
                onKeyDown={handleNewChatKeyDown}
              />
              {newChatError && <p className="text-red-400">{newChatError}</p>}
              <div className="flex gap-1">
                <button onClick={handleNewChatSubmit}>Start</button>
                <button onClick={() => setShowScanner(true)} aria-label="Scan QR code" title="Scan QR code"><QrCode size={14} /></button>
                <button onClick={closeNewChat} aria-label="Cancel"><X size={14} /></button>
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto overscroll-contain safe-bottom">
            <ConversationList
              conversations={conversations}
              activeAddress={recipientAddress}
              onSelect={(addr) => navigate(conversationPath(addr))}
              onNewConversation={openNewChat}
              onRemove={handleRemoveConversation}
              labels={labels}
              error={conversationsError}
              onRetry={reloadConversations}
            />
          </div>
        </nav>

        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {recipientAddress ? (
            <MessagePane
              key={recipientAddress}
              recipientAddress={recipientAddress}
              selfAddress={identity.address}
              labels={labels}
              onRename={(name) => setLabel(recipientAddress, name)}
              departed={departed.has(recipientAddress)}
              messages={messages}
              now={now}
              recovering={recovering}
              loading={messagesLoading}
              error={messagesError}
              onRetry={refreshMessages}
              olderError={messagesOlderError}
              hasMore={hasMore}
              loadingOlder={loadingOlder}
              fetchOlder={fetchOlder}
              openingFailed={openingFailed}
              onRetryOpening={retryOpening}
              onSendMessage={sendMessage}
              onClear={handleClearConversation}
              onBack={() => navigate('/chat')}
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-1 h-full p-4 text-center">
              <p className="m-0">No conversation selected</p>
              <p className="m-0 text-sm">End-to-end encrypted · messages disappear · your key is your account</p>
            </div>
          )}
        </div>
      </div>

      {showScanner && (
        <QRModal mode="scan" onClose={() => setShowScanner(false)} onScan={handleScan} />
      )}
    </div>
  )
}
