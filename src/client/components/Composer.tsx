import { useState, useRef, useEffect, useId } from 'preact/hooks'
import { Send, Timer, LoaderCircle } from 'lucide-preact'
import { MAX_PLAINTEXT_BYTES } from '../../shared/message-envelope'
import { MESSAGE_LIFETIMES, rememberLifetimeSelection, resolveComposerLifetime, subscribeDefaultLifetimeSetting } from '../lib/message-lifetime'
import { LifetimeOptions } from './LifetimeOptions'
import { useToast } from './Toast'

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
    } catch (err: any) {
      toast(err.message || 'Failed to send', 'error')
    } finally { setSending(false) }
  }

  const lifetimeLabel = MESSAGE_LIFETIMES.find((o) => o.seconds === ttl)?.label
  const shortLifetime = ttl <= SHORT_LIFETIME_SECONDS

  // The shell leaves the bottom inset to us: clear the home indicator,
  // but don't stack our own padding on top of it.
  if (departed) {
    return (
      <p role="status" className="m-0 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0 border-t border-neutral-800 text-center text-sm">
        {partnerName} deleted their identity. Messages can't be delivered.
      </p>
    )
  }

  return (
    <form className="p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shrink-0" onSubmit={(e) => { e.preventDefault(); handleSend() }}>
      <div className="flex items-center border border-neutral-800 rounded-lg bg-neutral-950">
        {/* The pill is what shows; the real select lies invisibly on top of
            it, so taps still open the native picker. */}
        <label className="relative flex items-center self-stretch shrink-0 px-1" title={`Messages you send disappear ${lifetimeLabel} after they are opened`}>
          <select
            value={ttl}
            onChange={(e: any) => { const seconds = Number(e.target.value); setTtl(seconds); rememberLifetimeSelection(seconds) }}
            aria-label={`Message lifetime: messages you send disappear ${lifetimeLabel} after they are opened`}
            className="peer absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          >
            <LifetimeOptions />
          </select>
          <span aria-hidden="true" className={`flex items-center gap-1 border rounded-full px-2 py-0.5 text-xs peer-focus-visible:border-accent ${shortLifetime ? 'border-red-400 text-red-400 font-bold' : 'border-neutral-800 text-neutral-400'}`}>
            <Timer size={12} />
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
          className={`flex-1 border-0 bg-transparent py-2.5 px-2 ${sending ? 'text-neutral-500' : ''}`}
        />
        <button type="submit" disabled={sending || !plaintext || overLimit} aria-label={sending ? 'Sending' : 'Send'} title={sending ? 'Sending…' : 'Send'} className={`border-0 p-0 px-2 text-neutral-200 hover:text-white ${sending ? 'disabled:opacity-100' : ''}`}>
          {sending ? <LoaderCircle size={18} className="animate-spin" /> : <Send size={18} />}
        </button>
      </div>
      {showByteCount && (
        <p id={byteCountId} className={`m-0 pt-1 px-2 text-right text-xs ${overLimit ? 'text-red-400' : 'text-neutral-400'}`}>
          {byteCount} / {MAX_PLAINTEXT_BYTES} bytes
        </p>
      )}
      {/* Always present: a live region only announces changes to itself. */}
      <span role="status" className="sr-only">{sending ? 'Sending…' : ''}</span>
    </form>
  )
}
