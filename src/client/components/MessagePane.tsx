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
  const toast = useToast()
  const [inputText, setInputText] = useState('')
  const [ttl, setTtl] = useState(60)
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px'
    }
  }, [inputText])

  const handleImageFile = async (file: File) => {
    const reader = new FileReader()
    reader.onload = (event) => {
      const base64 = event.target?.result as string
      if (base64) {
        setImagePreview(base64)
      }
    }
    reader.onerror = () => {
      toast('Failed to read image file', 'error')
    }
    reader.readAsDataURL(file)
  }

  const handlePaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile()
        if (!file) continue
        handleImageFile(file)
      }
    }
  }

  const handleFileInputChange = (e: any) => {
    const file = e.target.files?.[0]
    if (file) {
      handleImageFile(file)
    }
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(recipientAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleSend = async (content?: string) => {
    const messageContent = content || imagePreview || inputText.trim()
    if (!messageContent || sending) return

    setSending(true)
    try {
      await onSendMessage(messageContent, ttl)
      setInputText('')
      setImagePreview(null)
      toast('Message sent', 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to send message', 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-bg" onPaste={handlePaste}>
      <div className="p-4 border-b border-border flex items-center gap-4 bg-surface/30">
        <button onClick={onBack} className="md:hidden text-accent cursor-pointer p-1">
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-dim font-bold opacity-70">Recipient</div>
          <div className="text-sm font-mono flex items-center gap-2">
            <span className="truncate">{recipientAddress}</span>
            <button 
              onClick={handleCopy}
              className="hover:text-accent transition-colors shrink-0"
              title="Copy Address"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="h-full flex items-center justify-center text-dim italic text-sm opacity-40">
            No messages yet. Encryption is active.
          </div>
        )}
        {messages.map((msg) => {
          const isMine = msg.sender.toLowerCase() !== recipientAddress.toLowerCase()
          const isImage = msg.plaintext.startsWith('data:image/')

          return (
            <div key={msg.id} className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-[85%] p-3 rounded-sm text-sm leading-relaxed shadow-sm ${
                isMine ? 'bg-accent text-bg' : 'bg-surface border border-border text-text'
              }`}>
                {isImage ? (
                  <img src={msg.plaintext} alt="Encrypted attachment" className="max-w-full h-auto rounded-sm cursor-zoom-in" onClick={() => window.open(msg.plaintext, '_blank')} />
                ) : (
                  <div class="whitespace-pre-wrap break-words">{msg.plaintext}</div>
                )}
              </div>
              <div className="mt-1 flex gap-2 text-[8px] text-dim font-mono uppercase opacity-50">
                <span>{new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                <span>•</span>
                <span>Expires {new Date(msg.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      {imagePreview && (
        <div className="p-4 border-t border-border bg-surface/30 flex items-end gap-3">
          <div className="relative">
            <img src={imagePreview} alt="Preview" className="max-h-20 max-w-20 rounded-sm" />
            <button
              type="button"
              onClick={() => setImagePreview(null)}
              className="absolute -top-2 -right-2 bg-error text-white rounded-full p-1 hover:brightness-110 cursor-pointer"
              aria-label="Remove image"
            >
              <X size={14} />
            </button>
          </div>
          <button
            onClick={() => handleSend(imagePreview)}
            disabled={sending}
            className="bg-accent text-bg px-4 py-2 rounded-sm hover:brightness-110 disabled:opacity-50 cursor-pointer transition-all active:scale-95 text-xs font-bold uppercase"
          >
            Send Image
          </button>
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); handleSend() }} className="p-4 border-t border-border flex flex-col gap-3 bg-surface/20">
        <textarea
          ref={textareaRef}
          value={inputText}
          onInput={(e: any) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a secure message... (Shift+Enter for newline)"
          className="flex-1 bg-surface border border-border rounded-sm px-4 py-2.5 text-sm focus:outline-none focus:border-accent transition-colors resize-none overflow-hidden min-h-[2.5rem]"
          style={{ fieldSizing: 'content' }}
          autoComplete="off"
        />
        <div className="flex gap-3 items-center">
          <select
            value={ttl}
            onChange={(e: any) => setTtl(Number(e.target.value))}
            className="bg-surface border border-border rounded-sm px-2 py-1.5 text-[10px] text-dim cursor-pointer focus:border-accent outline-none font-bold uppercase tracking-tighter"
          >
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
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            className="text-dim hover:text-accent transition-colors p-2 cursor-pointer"
            title="Attach image"
          >
            <Paperclip size={18} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileInputChange}
            className="hidden"
          />
          <button
            type="submit"
            disabled={sending || (!inputText.trim() && !imagePreview)}
            className="ml-auto bg-accent text-bg p-2.5 rounded-sm hover:brightness-110 disabled:opacity-50 cursor-pointer transition-all active:scale-95"
          >
            <Send size={18} />
          </button>
        </div>
      </form>
    </div>
  )
}
