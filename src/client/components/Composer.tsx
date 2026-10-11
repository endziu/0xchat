import { useState, useRef, useEffect, useId } from 'preact/hooks'
import { Flame, Send, Timer, LoaderCircle } from 'lucide-preact'
import { MAX_PLAINTEXT_BYTES } from '../../shared/message-envelope'
import { MESSAGE_LIFETIMES, rememberLifetimeSelection, resolveComposerLifetime, subscribeDefaultLifetimeSetting } from '../lib/message-lifetime'
import { LifetimeOptions } from './LifetimeOptions'
import { useToast } from './Toast'
import { errorMessage } from '../lib/errors'

interface ComposerProps {
  // The partner burned their identity, so nothing more can be delivered.
  departed?: boolean
  partnerName: string
  onSendMessage: (plaintext: string, ttl: number) => Promise<any>
}

// Lifetimes this short are easy to pick by accident, so the chip says so loudly.
const SHORT_LIFETIME_SECONDS = 60

// Owns the draft, so typing re-renders only the composer, not the transcript.
export function Composer({ departed, partnerName, onSendMessage }: ComposerProps) {
  const { toast } = useToast()
  const [inputText, setInputText] = useState('')
  const plaintext = inputText.trim()
  const byteCount = new TextEncoder().encode(plaintext).length
  const overLimit = byteCount > MAX_PLAINTEXT_BYTES
  const showByteCount = byteCount >= MAX_PLAINTEXT_BYTES * 0.9
  const byteCountId = useId()
  // Resolved per conversation (the pane is keyed by recipient) and again
  // whenever the default setting changes: the configured default, else the
  // last selection, else 30 minutes.
  const [ttl, setTtl] = useState(resolveComposerLifetime)
  useEffect(() => subscribeDefaultLifetimeSetting(() => setTtl(resolveComposerLifetime())), [])
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const ta = textareaRef.current
    // Cap at 30% of the viewport, not a fixed 200px — on a phone with the
    // keyboard up, 200px of composer leaves almost no room for messages.
    if (ta) {
      const max = Math.max(96, Math.min(200, window.innerHeight * 0.3))
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, max) + 'px'
    }
  }, [inputText])

  const handleSend = async () => {
    if (!plaintext || sending || overLimit) return
    setSending(true)
    try {
      await onSendMessage(plaintext, ttl)
      setInputText('')
      // A per-message override is spent once sent: a fixed default resumes,
      // while "Remember last selection" resolves back to the same pick.
      setTtl(resolveComposerLifetime())
    } catch (err) {
      toast(errorMessage(err, 'Failed to send'), 'error')
    } finally { setSending(false) }
  }

  const lifetimeLabel = MESSAGE_LIFETIMES.find((o) => o.seconds === ttl)?.label
  const shortLifetime = ttl <= SHORT_LIFETIME_SECONDS

  // The shell leaves the bottom inset to us: clear the home indicator,
  // but don't stack our own padding on top of it.
  if (departed) {
    return (
      <p role="status" className="mx-3 mt-2 mb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0 rounded-md bg-raised px-4 py-3.5 text-center text-sm text-text-2">
        {partnerName} deleted their identity. Messages can't be delivered.
      </p>
    )
  }

  return (
    <form className="shrink-0 px-2.5 pt-2 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:px-4 sm:pt-2.5 sm:pb-4" onSubmit={(e) => { e.preventDefault(); handleSend() }}>
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 items-end gap-0.5 rounded-md border-[1.5px] border-field bg-bg p-1 focus-within:border-accent">
          {/* The chip is what shows; the real select lies invisibly on top of
              it, so taps still open the native picker. */}
          <label className={`relative inline-flex h-10 shrink-0 cursor-pointer items-center gap-1 rounded-sm px-3 text-xs font-bold has-[select:focus-visible]:outline-2 has-[select:focus-visible]:outline-accent ${shortLifetime ? 'bg-danger-soft text-danger' : 'bg-raised text-text-2'}`} title={`Messages you send disappear ${lifetimeLabel} after they are opened`}>
            <select
              value={ttl}
              onChange={(e: any) => { const seconds = Number(e.target.value); setTtl(seconds); rememberLifetimeSelection(seconds) }}
              aria-label={`Message lifetime: messages you send disappear ${lifetimeLabel} after they are opened`}
              className="absolute inset-0 min-h-0 cursor-pointer opacity-0"
            >
              <LifetimeOptions />
            </select>
            <span aria-hidden="true" className="inline-flex items-center gap-1">
              {shortLifetime ? <Flame size={15} /> : <Timer size={15} />}
              {lifetimeLabel}
            </span>
          </label>
          <textarea
            ref={textareaRef}
            value={inputText}
            onInput={(e: any) => setInputText(e.target.value)}
            // Phones have no Shift+Enter, so there Enter is a newline and the
            // Send button sends.
            onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); handleSend() } }}
            placeholder="Message..."
            autoComplete="off"
            rows={1}
            readOnly={sending}
            aria-invalid={overLimit || undefined}
            aria-describedby={showByteCount ? byteCountId : undefined}
            className={`min-h-10 flex-1 border-0 bg-transparent px-2 py-[9px] focus:border-0 ${sending ? 'text-text-3' : ''}`}
          />
        </div>
        <button type="submit" disabled={sending || !plaintext || overLimit} aria-label={sending ? 'Sending' : 'Send'} title={sending ? 'Sending…' : 'Send'} className="size-[50px] shrink-0 justify-center rounded-md bg-accent text-on-accent disabled:bg-raised disabled:text-text-3 disabled:opacity-100">
          {sending ? <LoaderCircle size={19} className="animate-spin" /> : <Send size={19} />}
        </button>
      </div>
      {showByteCount && (
        <p id={byteCountId} className={`px-2 pt-1 text-right text-xs ${overLimit ? 'text-danger' : 'text-text-2'}`}>
          {byteCount} / {MAX_PLAINTEXT_BYTES} bytes
        </p>
      )}
      {/* Always present: a live region only announces changes to itself. */}
      <span role="status" className="sr-only">{sending ? 'Sending…' : ''}</span>
    </form>
  )
}
