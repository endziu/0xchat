import { useState, useRef, useEffect } from 'preact/hooks'
import { ArrowLeft, Send, Copy, Check, Paperclip, X } from 'lucide-preact'
import { Message } from '../lib/api'
import { useToast } from './Toast'

interface MessagePaneProps {
  recipientAddress: string
  messages: (Message & { plaintext: string })[]
  onSendMessage: (plaintext: string, ttl: number) => Promise<any>
  onBack: () => void
}

export function MessagePane({ recipientAddress, messages, onSendMessage, onBack }: MessagePaneProps) {
  const { toast } = useToast()
  const [inputText, setInputText] = useState('')
  const [ttl, setTtl] = useState(60)
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  useEffect(() => {
    const ta = textareaRef.current
    if (ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px' }
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
      toast('Sent', 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to send', 'error')
    } finally { setSending(false) }
  }

  return (
    <div className="flex flex-col h-full" onPaste={handlePaste}>
      <div className="flex items-center gap-2 p-2 border-b border-neutral-800">
        <button onClick={onBack} className="border-0 p-1"><ArrowLeft size={18} /></button>
        <span className="flex-1 min-w-0 text-[11px] text-neutral-500 truncate">{recipientAddress}</span>
        <button onClick={() => { navigator.clipboard.writeText(recipientAddress); setCopied(true); setTimeout(() => setCopied(false), 2000) }} title="Copy" className="border-0 p-1">
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5">
        {messages.length === 0 && <div className="flex items-center justify-center h-full text-neutral-700">No messages yet</div>}
        {messages.map((msg) => {
          const isMine = msg.sender.toLowerCase() !== recipientAddress.toLowerCase()
          const isImage = msg.plaintext.startsWith('data:image/')
          return (
            <div key={msg.id} className={`max-w-[70%] ${isMine ? 'self-end' : 'self-start'}`}>
              <div className={`px-2.5 py-1.5 border border-neutral-800 break-words ${isMine ? 'bg-neutral-900' : ''}`}>
                {isImage ? <img src={msg.plaintext} alt="Attachment" onClick={() => window.open(msg.plaintext, '_blank')} /> : msg.plaintext}
              </div>
              <div className={`text-[10px] text-neutral-600 mt-0.5 flex gap-1 ${isMine ? 'justify-end' : ''}`}>
                <span>{new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                <span>·</span>
                <span>expires {new Date(msg.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      {imagePreview && (
        <div className="p-2 border-t border-neutral-800">
          <div className="inline-flex relative">
            <img src={imagePreview} alt="Preview" className="max-h-30 object-contain" />
            <button className="absolute top-0.5 right-0.5 border-0 bg-black/70 p-0.5" onClick={() => setImagePreview(null)} aria-label="Remove"><X size={14} /></button>
          </div>
          <button onClick={() => handleSend(imagePreview)} disabled={sending} className="mt-1.5">Send Image</button>
        </div>
      )}

      <form className="border-t border-neutral-800 p-2 flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); handleSend() }}>
        <textarea
          ref={textareaRef}
          value={inputText}
          onInput={(e: any) => setInputText(e.target.value)}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
          placeholder="Type a message... (Shift+Enter for newline)"
          autoComplete="off"
          rows={1}
        />
        <div className="flex items-center gap-1.5">
          <select value={ttl} onChange={(e: any) => setTtl(Number(e.target.value))}>
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
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={sending} title="Attach"><Paperclip size={16} /></button>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={(e: any) => { const f = e.target.files?.[0]; if (f) handleImageFile(f) }} hidden />
          <button type="submit" disabled={sending || (!inputText.trim() && !imagePreview)}><Send size={16} /></button>
        </div>
      </form>
    </div>
  )
}
