import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks'
import { ArrowLeft, Send, Copy, Check, Plus, X } from 'lucide-preact'
import { Message } from '../lib/api'
import { useToast } from './Toast'

interface MessagePaneProps {
  recipientAddress: string
  messages: (Message & { plaintext: string })[]
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  hasMore?: boolean
  loadingOlder?: boolean
  fetchOlder?: () => Promise<(Message & { plaintext: string })[]>
  prependMessages?: (fresh: (Message & { plaintext: string })[]) => void
  onSendMessage: (plaintext: string, ttl: number) => Promise<any>
  onBack: () => void
}

const shortAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

export function MessagePane({ recipientAddress, messages, loading, error, onRetry, hasMore, loadingOlder, fetchOlder, prependMessages, onSendMessage, onBack }: MessagePaneProps) {
  const { toast } = useToast()
  const [inputText, setInputText] = useState('')
  const [ttl, setTtl] = useState(1800)
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // State captured before a "load older" fetch, so the view can be
  // re-anchored once the older messages are prepended. We anchor on the
  // topmost visible message element rather than container arithmetic, so the
  // anchor stays put even when the load button itself unmounts on the final
  // page. Only one fetch is ever in flight (busyRef), so there is exactly
  // one pending capture and one commit to reason about.
  const pendingPreserveRef = useRef<{ anchor: Element | null; anchorTop: number } | null>(null)
  // Set on the commit of a real prepend; consumed by the layout effect.
  const prependCommittedRef = useRef(false)
  const busyRef = useRef(false)
  const lastNewestIdRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (messages.length === 0) {
      pendingPreserveRef.current = null
      prependCommittedRef.current = false
      lastNewestIdRef.current = null
      return
    }
    const newestId = messages[messages.length - 1].id
    // A real prepend committed: re-anchor on the captured topmost visible
    // article. When the anchor is gone (nothing visible at capture, or it
    // expired mid-fetch) no reference point survives, so stay with the
    // newest content — the same policy as the append path. SSE appends and
    // expiry removals never consume the pending state.
    if (prependCommittedRef.current) {
      prependCommittedRef.current = false
      const pending = pendingPreserveRef.current
      pendingPreserveRef.current = null
      if (pending !== null && pending.anchor !== null && pending.anchor.isConnected) {
        el.scrollTop += pending.anchor.getBoundingClientRect().top - pending.anchorTop
      } else {
        el.scrollTop = el.scrollHeight
      }
    } else if (newestId !== lastNewestIdRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
    lastNewestIdRef.current = newestId
  }, [messages])

  const handleLoadOlder = async () => {
    if (!fetchOlder || !prependMessages || busyRef.current) return
    busyRef.current = true
    try {
      const el = scrollRef.current
      let anchor: Element | null = null
      if (el) {
        const viewportTop = el.getBoundingClientRect().top
        for (const article of Array.from(el.querySelectorAll('article'))) {
          if (article.getBoundingClientRect().bottom > viewportTop) { anchor = article; break }
        }
      }
      pendingPreserveRef.current = {
        anchor,
        anchorTop: anchor?.getBoundingClientRect().top ?? 0,
      }
      const fresh = await fetchOlder()
      // The anchor is scroll-UX only — never a gate: the cursor has already
      // advanced, so the page is always prepended. Preact defers the render,
      // so the layout effect sees the flag on the prepend commit.
      if (fresh.length > 0) {
        prependCommittedRef.current = true
        prependMessages(fresh)
      } else {
        pendingPreserveRef.current = null
      }
    } finally {
      busyRef.current = false
    }
  }

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

  const handleImageFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = (e) => { if (e.target?.result) setImagePreview(e.target.result as string) }
    reader.onerror = () => toast('Failed to read image', 'error')
    reader.readAsDataURL(file)
  }

  const handlePaste = (e: ClipboardEvent) => {
    for (const item of e.clipboardData?.items ?? []) {
      if (item.type.startsWith('image/')) { const f = item.getAsFile(); if (f) handleImageFile(f) }
    }
  }

  const handleSend = async (content?: string) => {
    const msg = content || imagePreview || inputText.trim()
    if (!msg || sending) return
    setSending(true)
    try {
      await onSendMessage(msg, ttl)
      setInputText('')
      setImagePreview(null)
    } catch (err: any) {
      toast(err.message || 'Failed to send', 'error')
    } finally { setSending(false) }
  }

  return (
    <div className="flex flex-col h-full" onPaste={handlePaste}>
      <div className="flex items-center gap-2 p-2 border-b border-neutral-800">
        <button onClick={onBack} aria-label="Back to conversations" className="border-0"><ArrowLeft size={18} /></button>
        <span className="flex-1 min-w-0 text-sm text-neutral-500 truncate">
          <span className="max-sm:hidden">{recipientAddress}</span>
          <span className="sm:hidden">{recipientAddress.slice(0, 6)}...{recipientAddress.slice(-4)}</span>
        </span>
        <button onClick={() => { navigator.clipboard.writeText(recipientAddress); setCopied(true); setTimeout(() => setCopied(false), 2000) }} title="Copy" aria-label="Copy address" className="border-0">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain px-4 py-2 flex flex-col">
        {loading
          ? <div className="flex items-center justify-center h-full text-neutral-700">Loading...</div>
          : messages.length === 0 && (
            error
              ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
                  <span className="text-red-400">Failed to load messages</span>
                  <span className="text-sm text-neutral-600">{error}</span>
                  {onRetry && <button onClick={onRetry}>Retry</button>}
                </div>
              )
              : <div className="flex items-center justify-center h-full text-neutral-700">No messages yet</div>
          )
        }
        {!loading && hasMore && (
          <button onClick={handleLoadOlder} disabled={loadingOlder} aria-label="Load older messages" title="Load older messages" className="border-0 self-center mb-2 text-xs text-neutral-500">
            {loadingOlder ? 'Loading…' : 'Load older messages'}
          </button>
        )}
        {messages.map((msg, i) => {
          const isMine = msg.sender.toLowerCase() !== recipientAddress.toLowerCase()
          const isImage = msg.plaintext.startsWith('data:image/')
          const prev = messages[i - 1]
          const sameSender = prev && prev.sender.toLowerCase() === msg.sender.toLowerCase()
          const sameMinute = sameSender && fmtTime(prev.created_at) === fmtTime(msg.created_at)

          return (
            <article key={msg.id} className={`flex gap-3 ${sameSender ? 'mt-0.5' : 'mt-3 first:mt-0'} group hover:bg-neutral-950/50`}>
              <time className={`w-10 shrink-0 text-xs text-neutral-700 pt-0.5 text-right ${sameMinute ? 'invisible group-hover:visible' : ''}`}>
                {fmtTime(msg.created_at)}
              </time>
              <div className={`min-w-0 flex-1 ${!sameSender ? `pl-2 border-l-2 ${isMine ? 'border-neutral-700' : 'border-neutral-400'}` : 'pl-2 border-l-2 border-transparent'}`}>
                {!sameSender && (
                  <span className={`text-sm font-bold ${isMine ? 'text-neutral-500' : 'text-neutral-200'}`}>
                    {shortAddr(msg.sender)}
                  </span>
                )}
                {isImage ? (
                  <img src={msg.plaintext} alt="Attachment" className="max-w-xs max-sm:max-w-full mt-1 border-0 cursor-pointer" onClick={() => window.open(msg.plaintext, '_blank')} />
                ) : (
                  <p className={`m-0 break-words ${isMine ? 'text-neutral-400' : 'text-neutral-200'}`}>{msg.plaintext}</p>
                )}
                {!sameSender && (
                  <span className="text-xs text-neutral-700 ml-2">expires {fmtTime(msg.expires_at)}</span>
                )}
              </div>
            </article>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      <form className="p-2 shrink-0" onSubmit={(e) => { e.preventDefault(); handleSend() }}>
        {imagePreview && (
          <div className="mb-2 border border-neutral-800 p-2">
            <figure className="inline-flex relative m-0">
              <img src={imagePreview} alt="Preview" className="max-h-30 object-contain border-0" />
              <button type="button" className="absolute top-0.5 right-0.5 border-0 bg-black/70 p-0.5" onClick={() => setImagePreview(null)} aria-label="Remove"><X size={14} /></button>
            </figure>
          </div>
        )}
        <div className="flex items-center border border-neutral-800 rounded-lg bg-neutral-950">
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={sending} aria-label="Attach image" title="Attach" className="border-0 p-0 px-2 text-neutral-600 hover:text-neutral-300">
            <Plus size={18} />
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={(e: any) => { const f = e.target.files?.[0]; if (f) handleImageFile(f) }} hidden />
          <select value={ttl} onChange={(e: any) => setTtl(Number(e.target.value))} aria-label="Message expiry" className="border-0 bg-transparent text-xs text-neutral-600 py-0 pl-1 pr-0 cursor-pointer">
            <option value={5}>5s</option>
            <option value={10}>10s</option>
            <option value={30}>30s</option>
            <option value={60}>1m</option>
            <option value={300}>5m</option>
            <option value={1800}>30m</option>
            <option value={3600}>1h</option>
            <option value={21600}>6h</option>
            <option value={86400}>24h</option>
          </select>
          <textarea
            ref={textareaRef}
            value={inputText}
            onInput={(e: any) => setInputText(e.target.value)}
            onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            placeholder="Message..."
            autoComplete="off"
            rows={1}
            className="flex-1 border-0 bg-transparent py-2.5 px-2"
          />
          <button type="submit" disabled={sending || (!inputText.trim() && !imagePreview)} aria-label="Send" title="Send" className="border-0 p-0 px-2 text-neutral-600 hover:text-neutral-300">
            <Send size={18} />
          </button>
        </div>
      </form>
    </div>
  )
}
