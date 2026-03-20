import { useState, useRef, useEffect } from 'preact/hooks'
import { ArrowLeft, Send, Copy, Check } from 'lucide-preact'
import { Message } from '../lib/api'

interface MessagePaneProps {
  recipientAddress: string
  messages: (Message & { plaintext: string })[]
  onSendMessage: (plaintext: string, ttl: number) => Promise<any>
  onBack: () => void
}

export function MessagePane({ recipientAddress, messages, onSendMessage, onBack }: MessagePaneProps) {
  const [inputText, setInputText] = useState('')
  const [ttl, setTtl] = useState(300)
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handlePaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile()
        if (!file) continue

        const reader = new FileReader()
        reader.onload = async (event) => {
          const base64 = event.target?.result as string
          if (base64) {
            setSending(true)
            try {
              await onSendMessage(base64, ttl)
            } catch (err: any) {
              alert(err.message || 'Failed to send image')
            } finally {
              setSending(false)
            }
          }
        }
        reader.readAsDataURL(file)
      }
    }
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(recipientAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleSend = async (e?: any) => {
    if (e) e.preventDefault()
    if (!inputText.trim() || sending) return

    setSending(true)
    try {
      await onSendMessage(inputText, ttl)
      setInputText('')
    } catch (err: any) {
      alert(err.message || 'Failed to send message')
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
                  msg.plaintext
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

      <form onSubmit={handleSend} className="p-4 border-t border-border flex gap-3 bg-surface/20">
        <input
          type="text"
          value={inputText}
          onInput={(e: any) => setInputText(e.target.value)}
          placeholder="Type a secure message..."
          className="flex-1 bg-surface border border-border rounded-sm px-4 py-2.5 text-sm focus:outline-none focus:border-accent transition-colors"
          autoComplete="off"
        />
        <select 
          value={ttl} 
          onChange={(e: any) => setTtl(Number(e.target.value))}
          className="bg-surface border border-border rounded-sm px-2 text-[10px] text-dim cursor-pointer focus:border-accent outline-none font-bold uppercase tracking-tighter"
        >
          <option value={30}>30s</option>
          <option value={300}>5m</option>
          <option value={3600}>1h</option>
          <option value={86400}>24h</option>
        </select>
        <button
          type="submit"
          disabled={sending || !inputText.trim()}
          className="bg-accent text-bg p-2.5 rounded-sm hover:brightness-110 disabled:opacity-50 cursor-pointer transition-all active:scale-95"
        >
          <Send size={18} />
        </button>
      </form>
    </div>
  )
}
