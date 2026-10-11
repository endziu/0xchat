import { checksumAddress, shortAddress, type Address } from '../../shared/address'
import { Fragment } from 'preact'
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks'
import { ArrowLeft, Copy, Check, Flame, Lock, RotateCw, Timer, X, Trash2 } from 'lucide-preact'
import { Message } from '../lib/api'
import { useToast } from './Toast'
import { ErrorState } from './ErrorState'
import { MessageText } from './MessageText'
import { AddressAvatar } from './AddressAvatar'
import { Composer } from './Composer'
import { useCopied } from '../hooks/useCopied'
import { errorMessage } from '../lib/errors'
import { displayName, fmtDay, fmtRemaining, fmtTime } from '../lib/display'

interface MessagePaneProps {
  recipientAddress: Address
  selfAddress: Address
  labels: Record<Address, string>
  // An empty name removes the label.
  onRename: (name: string) => void
  // The partner burned their identity, so nothing more can be delivered.
  departed?: boolean
  // The live stream dropped after having connected; it is retrying.
  reconnecting?: boolean
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

export function MessagePane({ recipientAddress, selfAddress, labels, onRename, departed, reconnecting, messages, now: serverNow, recovering = false, loading, error, onRetry, olderError, hasMore, loadingOlder, fetchOlder, openingFailed, onRetryOpening, onSendMessage, onClear, onBack }: MessagePaneProps) {
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
    } catch (err) {
      toast(errorMessage(err, 'Failed to clear conversation'), 'error')
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
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-16 shrink-0 items-center gap-2.5 border-b border-line px-2 py-1.5 sm:pl-4">
        {/* The list is beside the pane on wider screens, so no way back is needed. */}
        <button onClick={onBack} aria-label="Back to conversations" className="icon-btn sm:hidden"><ArrowLeft size={22} /></button>
        <AddressAvatar address={recipientAddress} size={40} />
        {renaming ? (
          <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); saveName() }}>
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
              className="min-w-0 flex-1"
            />
            <button type="submit" aria-label="Save name" title="Save" className="icon-btn text-accent-text"><Check size={20} /></button>
            <button type="button" onClick={() => setRenaming(false)} aria-label="Cancel rename" title="Cancel" className="icon-btn"><X size={20} /></button>
          </form>
        ) : (
          <>
            <button
              onClick={startRename}
              title={label ? 'Rename' : 'Add a name'}
              aria-label={label ? `Rename ${label}` : 'Add a name'}
              className="grid min-w-0 flex-1 justify-items-start text-left leading-tight"
            >
              <b className={`max-w-full truncate text-lg font-bold ${label ? '' : 'font-mono'}`}>{label || shortAddress(recipientAddress)}</b>
              <small className="max-w-full truncate text-xs text-text-3">
                {label ? (
                  <span className="font-mono">
                    <span className="max-sm:hidden">{checksumAddress(recipientAddress)}</span>
                    <span className="sm:hidden">{shortAddress(recipientAddress)}</span>
                  </span>
                ) : 'Add a name'}
              </small>
            </button>
            <button onClick={() => copy(checksumAddress(recipientAddress))} title="Copy address" aria-label="Copy address" className="icon-btn">
              {copied ? <Check size={20} /> : <Copy size={20} />}
            </button>
            <button
              onClick={handleClear}
              disabled={clearing}
              title="Clear conversation for both of you"
              aria-label={clearConfirm ? 'Confirm clear conversation' : 'Clear conversation'}
              className={clearConfirm ? 'btn btn-danger btn-sm' : 'icon-btn'}
            >
              {clearConfirm ? 'Clear for both?' : <Trash2 size={20} />}
            </button>
          </>
        )}
      </header>

      {reconnecting && (
        <div role="status" className="mt-2 inline-flex items-center gap-1.5 self-center rounded-sm bg-raised px-3 py-1 text-xs text-text-2"><RotateCw size={14} />Reconnecting…</div>
      )}
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

      <div ref={scrollRef} onScroll={handleScroll} role="log" aria-label="Messages" className="flex flex-1 flex-col overflow-y-auto overscroll-contain px-3 pt-3 pb-2 sm:px-6 sm:pt-4">
        {/* Takes the free space above a short conversation, so it sits on the composer. */}
        <div className="mt-auto" />
        {loading
          ? <div className="flex flex-1 items-center justify-center text-text-3">Loading...</div>
          : !error && messages.length === 0 && (
            <div className="mx-2 mt-auto mb-3 grid justify-items-center gap-1.5 rounded-md bg-raised px-5.5 py-5 text-center text-sm text-text-2">
              <Lock size={20} />
              <b className="text-base text-text">No messages yet</b>
              <p>Messages here are end-to-end encrypted. Each one disappears once its lifetime runs out after it is opened.</p>
            </div>
          )
        }
        {!loading && hasMore && (
          <div className="mb-2 grid justify-items-center gap-1.5 self-center">
            {olderError && <span className="text-sm text-danger">{olderError}</span>}
            <button onClick={handleLoadOlder} disabled={loadingOlder} aria-label="Load older messages" title="Load older messages" className="btn btn-sm">
              {loadingOlder ? 'Loading…' : olderError ? 'Retry' : 'Load older messages'}
            </button>
          </div>
        )}
        {messages.map((msg, i) => {
          const isMine = msg.sender !== recipientAddress
          const prev = messages[i - 1]
          const next = messages[i + 1]
          // A conversation can span midnight: mark where each earlier day starts.
          const day = fmtDay(msg.created_at, now)
          const newDay = prev ? day !== fmtDay(prev.created_at, now) : day !== null
          const nextNewDay = next !== undefined && fmtDay(next.created_at, now) !== day
          // Bubbles from one sender stack, with tight corners where they meet.
          const first = newDay || !prev || prev.sender !== msg.sender
          const last = nextNewDay || !next || next.sender !== msg.sender
          const opened = !isMine || msg.opened_at !== null
          const remaining = fmtRemaining(msg.expires_at, now)
          const burning = opened && msg.expires_at - now <= 60_000
          const corners = isMine
            ? `rounded-l-md ${first ? 'rounded-tr-md' : 'rounded-tr-xs'} ${last ? 'rounded-br-md' : 'rounded-br-xs'}`
            : `rounded-r-md ${first ? 'rounded-tl-md' : 'rounded-tl-xs'} ${last ? 'rounded-bl-md' : 'rounded-bl-xs'}`

          return (
            <Fragment key={msg.id}>
              {newDay && <div className="mt-4 mb-2 self-center rounded-sm bg-raised px-3 py-0.5 text-xs font-semibold text-text-2">{day ?? 'Today'}</div>}
              <article
                data-message-id={msg.id}
                className={`max-w-[min(78%,34em)] px-3.5 pt-2 pb-1.5 ${first ? 'mt-2.5' : 'mt-0.5'} ${corners} ${isMine ? 'self-end bg-bubble-mine text-on-bubble-mine' : 'self-start bg-bubble-them text-text shadow-[0_0_0_1px_var(--color-line)] dark:shadow-none'}`}
              >
                {first && <span className="sr-only">{displayName(msg.sender, labels, selfAddress)}</span>}
                <MessageText plaintext={msg.plaintext} className="leading-snug [overflow-wrap:anywhere]" />
                <span className={`mt-0.5 flex items-center justify-end gap-2.5 text-[11.5px] whitespace-nowrap ${isMine ? 'text-on-bubble-mine/85' : 'text-text-3'}`}>
                  <time>{fmtTime(msg.created_at)}</time>
                  {/* Hidden from screen readers: inside the log, each tick would be announced. */}
                  {opened ? (
                    <span className={`inline-flex items-center gap-0.5 ${burning ? `font-extrabold ${isMine ? 'text-on-bubble-mine' : 'text-danger'}` : ''}`} title={`Disappears in ${remaining}`} aria-hidden="true">
                      {burning ? <Flame size={13} /> : <Timer size={13} />}{remaining}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-0.5" title="Not opened yet">
                      <Check size={13} />not opened
                    </span>
                  )}
                </span>
              </article>
            </Fragment>
          )
        })}
      </div>

      <Composer departed={departed} partnerName={displayName(recipientAddress, labels, selfAddress)} onSendMessage={onSendMessage} />
    </div>
  )
}
