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
import { Keypair } from '../../shared/keypair'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { markConversationSeen } from '../lib/contacts'
import type { ConnectionEpoch } from '../lib/sse-connection'
import type { LiveEvent } from '../../shared/live-events'
import { Camera, Lock, Plus } from 'lucide-preact'
import type { ComponentChildren } from 'preact'
import { Modal } from './Modal'
import { QRModal } from './QRModal'

interface ChatViewProps {
  recipientAddress: Address | null
  identity: Keypair
  token: string
  navigate: (to: string) => void
  onConnectedChange?: (connected: boolean) => void
  // The identity bar Layout puts at the top of the chats panel.
  sidebarTop?: ComponentChildren
  onShare: () => void
}

export function ChatView({ recipientAddress, identity, token, navigate, onConnectedChange, sidebarTop, onShare }: ChatViewProps) {
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
  // The first connection is not a reconnection: before it, the live dot alone
  // says "connecting". After it, a lost stream is shown until it is back.
  const [everConnected, setEverConnected] = useState(false)
  useEffect(() => { if (connected) setEverConnected(true) }, [connected])
  const reconnecting = everConnected && !connected

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
  // showModal focuses the sheet's first control, its Cancel button; typing
  // the address is what the sheet is for.
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
    } catch (err) {
      setNewChatError(errorMessage(err, 'Failed to check registration.'))
    }
  }

  const handleNewChatSubmit = () => {
    if (!newChatAddr) return
    resolveAndNavigate(newChatAddr)
  }

  const handleScan = (addr: Address) => {
    setShowScanner(false)
    setNewChatAddr(checksumAddress(addr))
    resolveAndNavigate(addr)
  }

  const listEmpty = conversations.length === 0 && !conversationsError

  return (
    <div className="flex flex-1 flex-col overflow-hidden min-h-0 sm:gap-3">
      {/* Outside the responsive row, which hides one pane on small screens. */}
      {updateRequired && (
        <div role="alert" className="mx-3 mt-2 flex shrink-0 items-center gap-3 rounded-md bg-accent-soft py-2 pr-2 pl-4 text-sm font-semibold sm:m-0">
          <span className="flex-1">0xChat has been updated. Reload to keep chatting.</span>
          <button onClick={() => void reloadForUpdate()} className="btn btn-accent btn-sm">Reload to update</button>
        </div>
      )}
      <div className={`flex flex-1 min-h-0 overflow-hidden sm:gap-3 ${recipientAddress ? 'max-sm:[&>:first-child]:hidden' : 'max-sm:[&>:last-child]:hidden'}`}>
        <nav className="relative flex w-full shrink-0 flex-col bg-surface sm:w-80 sm:rounded-md sm:border sm:border-line sm:shadow-panel lg:w-[360px]">
          {sidebarTop}
          <div className="flex shrink-0 items-center justify-between pt-3.5 pr-4 pb-2.5 pl-5">
            <h1 className="text-3xl font-bold tracking-[-0.01em]">Chats</h1>
            {!listEmpty && (
              // A floating button under the thumb on phones; beside the title on wider screens.
              <button onClick={openNewChat} className="btn max-sm:btn-accent max-sm:absolute max-sm:right-4 max-sm:bottom-[max(16px,calc(env(safe-area-inset-bottom)+4px))] max-sm:z-10 max-sm:h-[52px] max-sm:px-5 max-sm:text-base max-sm:font-bold max-sm:shadow-[0_6px_20px_rgb(30_30_80/.25)]">
                <Plus size={18} />New chat
              </button>
            )}
          </div>
          <div className={`flex flex-1 flex-col overflow-y-auto overscroll-contain px-2 sm:pb-2 ${listEmpty ? 'pb-[env(safe-area-inset-bottom)]' : 'pb-[calc(88px+env(safe-area-inset-bottom))]'}`}>
            <ConversationList
              conversations={conversations}
              activeAddress={recipientAddress}
              selfAddress={identity.address}
              onSelect={(addr) => navigate(conversationPath(addr))}
              onNewConversation={openNewChat}
              onShare={onShare}
              onRemove={handleRemoveConversation}
              labels={labels}
              error={conversationsError}
              onRetry={reloadConversations}
            />
          </div>
        </nav>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface sm:rounded-md sm:border sm:border-line sm:shadow-panel">
          {recipientAddress ? (
            <MessagePane
              key={recipientAddress}
              recipientAddress={recipientAddress}
              selfAddress={identity.address}
              labels={labels}
              onRename={(name) => setLabel(recipientAddress, name)}
              departed={departed.has(recipientAddress)}
              reconnecting={reconnecting}
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
            <div className="flex h-full flex-col items-center justify-center gap-2.5 p-6 text-center text-text-3">
              <Lock size={22} />
              <p>No conversation selected</p>
              <p className="text-sm">End-to-end encrypted · messages disappear · your key is your account</p>
            </div>
          )}
        </section>
      </div>

      {newChatOpen && (
        <Modal title="New chat" action="Cancel" kind="sheet" onClose={closeNewChat}>
          <form className="grid min-h-0 gap-3.5 overflow-y-auto overscroll-contain px-5 pt-2 pb-6" onSubmit={(e) => { e.preventDefault(); handleNewChatSubmit() }}>
            <label className="grid gap-1.5 text-sm font-semibold text-text-2">
              <span>Address</span>
              <input
                ref={newChatInputRef}
                type="text"
                aria-label="Address"
                placeholder="0x..."
                autocomplete="off"
                autocorrect="off"
                autocapitalize="none"
                spellcheck={false}
                className="font-mono"
                value={newChatAddr ?? ''}
                onInput={(e: any) => { setNewChatAddr(e.target.value); setNewChatError('') }}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-text-2">
              <span>Name (optional)</span>
              <input
                type="text"
                aria-label="Name (optional)"
                placeholder="Name (optional)"
                autocomplete="off"
                maxLength={64}
                value={newChatName}
                onInput={(e: any) => setNewChatName(e.target.value)}
              />
            </label>
            {newChatError && <p role="alert" className="text-sm text-danger">{newChatError}</p>}
            <div className="flex gap-2">
              <button type="submit" className="btn btn-accent btn-lg flex-1">Start</button>
              <button type="button" onClick={() => setShowScanner(true)} aria-label="Scan QR code" title="Scan QR code" className="btn btn-lg flex-1"><Camera size={18} />Scan QR</button>
            </div>
          </form>
        </Modal>
      )}

      {showScanner && (
        <QRModal mode="scan" onClose={() => setShowScanner(false)} onScan={handleScan} />
      )}
    </div>
  )
}
