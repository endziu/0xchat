import { checksumAddress, shortAddress, type Address } from '../../shared/address'
import { Fragment } from 'preact'
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks'
import { ArrowLeft, Copy, Check, X, Trash2 } from 'lucide-preact'
import { Message } from '../lib/api'
import { useToast } from './Toast'
import { ErrorState } from './ErrorState'
import { MessageText } from './MessageText'
import { AddressAvatar } from './AddressAvatar'
import { Composer } from './Composer'
import { useCopied } from '../hooks/useCopied'
import { displayName, fmtDay, fmtRemaining, fmtTime } from '../lib/display'

interface MessagePaneProps {
  recipientAddress: Address
  selfAddress: Address
  labels: Record<Address, string>
  // An empty name removes the label.
  onRename: (name: string) => void
  // The partner burned their identity, so nothing more can be delivered.
  departed?: boolean
  messages: (Message & { plaintext: string })[]
  // Server time, the clock that decides when messages disappear.
  now: () => number
  recovering?: boolean
  loading?: boolean
  error: string | null
  onRetry: () => void
  olderError: string | null
  hasMore?: boolean
  loadingOlder?: boolean
  fetchOlder?: () => Promise<void>
  // Incoming messages whose opening was not confirmed stay hidden until retry.
  openingFailed?: boolean
  onRetryOpening?: () => void
  onSendMessage: (plaintext: string, ttl: number) => Promise<any>
  // Deletes every message in the conversation, for both participants.
  onClear: () => Promise<void>
  onBack: () => void
}

export function MessagePane({ recipientAddress, selfAddress, labels, onRename, departed, messages, now: serverNow, recovering = false, loading, error, onRetry, olderError, hasMore, loadingOlder, fetchOlder, openingFailed, onRetryOpening, onSendMessage, onClear, onBack }: MessagePaneProps) {
  const { toast } = useToast()
  const [copied, copy] = useCopied()
  const label = labels[recipientAddress]
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (renaming) nameInputRef.current?.focus() }, [renaming])
  // Clearing is irreversible for both sides, so it takes two taps; the second
  // tap's question is spelled out, since touch screens show no title.
  const [clearConfirm, setClearConfirm] = useState(false)
  const [clearing, setClearing] = useState(false)
  const clearConfirmTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(clearConfirmTimeout.current), [])
  const scrollRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const lastNewestIdRef = useRef<string | null>(null)

  const positionRef = useRef<{ id: string; top: number }[]>([])
  const followingRef = useRef(true)
  const restoreAfterRecovery = useRef(false)
  const capturePosition = () => {
    const el = scrollRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    const articles = Array.from(el.querySelectorAll<HTMLElement>('article[data-message-id]'))
    positionRef.current = articles.map(article => ({ id: article.dataset.messageId!, top: article.getBoundingClientRect().top }))
      .sort((a, b) => Math.abs(a.top - top) - Math.abs(b.top - top))
  }
  const handleScroll = () => {
    if (recovering) return
    const el = scrollRef.current
    if (!el) return
    followingRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    capturePosition()
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Keep the pre-disconnect anchor while changeable content is hidden.
    if (recovering) { restoreAfterRecovery.current = true; return }
    if ((restoreAfterRecovery.current || !followingRef.current) && positionRef.current.length) {
      for (const prior of positionRef.current) {
        const anchor = el.querySelector(`[data-message-id="${prior.id}"]`)
        if (!anchor) continue
        el.scrollTop += anchor.getBoundingClientRect().top - prior.top
        break
      }
      // Recovered incoming messages may appear later, after opening confirms.
      // Keep this anchor until the next user scroll, including those renders.
      if (restoreAfterRecovery.current) followingRef.current = false
      restoreAfterRecovery.current = false
      lastNewestIdRef.current = messages.at(-1)?.id ?? null
      capturePosition()
      return
    }
    restoreAfterRecovery.current = false
    if (messages.length === 0) {
      lastNewestIdRef.current = null
      return
    }
    const newestId = messages[messages.length - 1].id
    if (newestId !== lastNewestIdRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
    lastNewestIdRef.current = newestId
    capturePosition()
  }, [messages, recovering])

  const handleLoadOlder = async () => {
    if (!fetchOlder || busyRef.current) return
    busyRef.current = true
    try {
      capturePosition()
      followingRef.current = false
      await fetchOlder()
    } finally {
      busyRef.current = false
    }
  }

  const handleClear = async () => {
    clearTimeout(clearConfirmTimeout.current)
    if (!clearConfirm) {
      setClearConfirm(true)
      clearConfirmTimeout.current = setTimeout(() => setClearConfirm(false), 3000)
      return
    }
    setClearConfirm(false)
    setClearing(true)
    try {
      await onClear()
      toast('Conversation cleared', 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to clear conversation', 'error')
    } finally { setClearing(false) }
  }

  const startRename = () => { setNameDraft(label ?? ''); setRenaming(true) }
  const saveName = () => { onRename(nameDraft); setRenaming(false) }

  // Remaining lifetimes count down once a second while any message is shown.
  const [, setTick] = useState(0)
  const hasMessages = messages.length > 0
  useEffect(() => {
    if (!hasMessages) return
    const timer = setInterval(() => setTick(tick => tick + 1), 1000)
    return () => clearInterval(timer)
  }, [hasMessages])
  const now = serverNow()

  return (
    <div className="flex flex-col h-full">
      {/* Same height and edges as the app bar above: on phones both are just
          their 44px targets, and the back arrow sits on the logo's left edge.
          On wider screens the list's header matches this height. */}
      <div className="flex items-center gap-2 min-h-11 sm:h-14 px-2 border-b border-neutral-800">
        {/* The list is beside the pane on wider screens, so no way back is needed. */}
        <button onClick={onBack} aria-label="Back to conversations" className="border-0 justify-start px-0 sm:hidden"><ArrowLeft size={18} /></button>
        <AddressAvatar address={recipientAddress} size={28} />
        {renaming ? (
          <form className="flex flex-1 min-w-0 items-center gap-1" onSubmit={(e) => { e.preventDefault(); saveName() }}>
            <input
              ref={nameInputRef}
              type="text"
              aria-label="Name"
              placeholder="Name"
              autocomplete="off"
              maxLength={64}
              value={nameDraft}
              onInput={(e: any) => setNameDraft(e.target.value)}
              onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape') setRenaming(false) }}
              className="min-w-0 flex-1 py-1"
            />
            <button type="submit" aria-label="Save name" title="Save" className="border-0 header-action"><Check size={14} /></button>
            <button type="button" onClick={() => setRenaming(false)} aria-label="Cancel rename" title="Cancel" className="border-0 header-action"><X size={14} /></button>
          </form>
        ) : (
          <>
            <button
              onClick={startRename}
              title={label ? 'Rename' : 'Add a name'}
              aria-label={label ? `Rename ${label}` : 'Add a name'}
              className="border-0 flex-1 min-w-0 flex-col items-start justify-center gap-0 px-0 py-0 leading-tight text-left hover:bg-transparent"
            >
              <span className="max-w-full truncate">{label || shortAddress(recipientAddress)}</span>
              <span className="max-w-full truncate text-xs text-neutral-500">
                {label ? (
                  <>
                    <span className="max-sm:hidden">{checksumAddress(recipientAddress)}</span>
                    <span className="sm:hidden">{shortAddress(recipientAddress)}</span>
                  </>
                ) : 'Add a name'}
              </span>
            </button>
            <button onClick={() => copy(checksumAddress(recipientAddress))} title="Copy address" aria-label="Copy address" className="border-0 header-action">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            <button
              onClick={handleClear}
              disabled={clearing}
              title="Clear conversation for both of you"
              aria-label={clearConfirm ? 'Confirm clear conversation' : 'Clear conversation'}
              className={`border-0 header-action ${clearConfirm ? 'text-red-400' : ''}`}
            >
              {clearConfirm ? <span className="text-sm whitespace-nowrap">Clear for both of you?</span> : <Trash2 size={14} />}
            </button>
          </>
        )}
      </div>

      {/* Outside the scroll area on purpose: the pane auto-scrolls to the
          newest message, so a notice placed above the list would be scrolled
          out of sight exactly when a refresh fails over existing messages. */}
      {error && <ErrorState title="Failed to load messages" detail={error} onRetry={onRetry} />}
      {openingFailed && onRetryOpening && (
        <ErrorState
          title="Some messages could not be opened"
          detail="They stay hidden until the server confirms opening."
          onRetry={onRetryOpening}
        />
      )}

      <div ref={scrollRef} onScroll={handleScroll} role="log" aria-label="Messages" className="flex-1 overflow-y-auto overscroll-contain px-4 py-2 flex flex-col">
        {/* Takes the free space above a short conversation, so it sits on the composer. */}
        <div className="mt-auto" />
        {loading
          ? <div className="flex flex-1 items-center justify-center text-neutral-500">Loading...</div>
          : !error && messages.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
              <p className="m-0">No messages yet</p>
              <p className="m-0 text-sm">Messages here are end-to-end encrypted. Each one disappears once its lifetime runs out after it is opened.</p>
            </div>
          )
        }
        {!loading && hasMore && (
          <div className="self-center mb-2 flex flex-col items-center gap-1">
            {olderError && <span className="text-xs text-red-400">{olderError}</span>}
            <button onClick={handleLoadOlder} disabled={loadingOlder} aria-label="Load older messages" title="Load older messages" className="border-0 text-xs text-neutral-500">
              {loadingOlder ? 'Loading…' : olderError ? 'Retry' : 'Load older messages'}
            </button>
          </div>
        )}
        {messages.map((msg, i) => {
          const isMine = msg.sender !== recipientAddress
          const prev = messages[i - 1]
          // A conversation can span midnight: mark where each earlier day starts.
          const day = fmtDay(msg.created_at, now)
          const newDay = prev ? day !== fmtDay(prev.created_at, now) : day !== null
          const sameSender = !newDay && prev && prev.sender === msg.sender
          const sameMinute = sameSender && fmtTime(prev.created_at) === fmtTime(msg.created_at)
          const remaining = fmtRemaining(msg.expires_at, now)

          return (
            <Fragment key={msg.id}>
              {newDay && <div className="self-center mt-3 text-xs text-neutral-500">{day ?? 'Today'}</div>}
              <article data-message-id={msg.id} className={`flex gap-3 ${sameSender ? 'mt-0.5' : i === 0 ? '' : 'mt-3'} group hover:bg-neutral-950/50`}>
                <time className={`w-10 shrink-0 text-xs text-neutral-500 pt-0.5 text-right ${sameMinute ? 'invisible group-hover:visible' : ''}`}>
                  {fmtTime(msg.created_at)}
                </time>
                <div className={`min-w-0 flex-1 pl-2 border-l-2 ${isMine ? 'border-accent' : 'border-neutral-500'}`}>
                  {!sameSender && (
                    <span className={`flex items-center gap-1.5 text-sm font-bold ${isMine ? 'text-neutral-400' : 'text-neutral-200'}`}>
                      <AddressAvatar address={msg.sender} size={16} />
                      {displayName(msg.sender, labels, selfAddress)}
                    </span>
                  )}
                  <MessageText plaintext={msg.plaintext} className={isMine ? 'text-neutral-400' : 'text-neutral-200'} />
                </div>
                {/* Hidden from screen readers: inside the log, each tick would be announced. */}
                <span className="shrink-0 text-xs text-neutral-500 pt-0.5" title={`Disappears in ${remaining}`} aria-hidden="true">
                  {remaining}
                </span>
              </article>
            </Fragment>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      <Composer departed={departed} partnerName={displayName(recipientAddress, labels, selfAddress)} onSendMessage={onSendMessage} />
    </div>
  )
}
