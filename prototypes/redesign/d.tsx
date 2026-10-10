// PROTOTYPE — Direction D, "Quiet": a familiar messaging app, made calm. Warm
// neutrals, soft rounded panels, bubbles, grouped settings lists. Type chosen
// for legibility, which matters most for hex addresses.
import { useState } from 'preact/hooks'
import { ArrowLeft, Camera, Check, ChevronRight, CircleHelp, Copy, Eye, EyeOff, Flame, Link, Lock, Plus, QrCode, RotateCw, Send, Settings, Timer, Trash2, X } from 'lucide-preact'
import {
  CONVS, COPY, IMPORTED, LIFETIMES, LIFETIME_WORDS, NEWBIE, PRIVATE_KEY, SELF, chatFor, chunks, convOf, fmtLeft, nameOf, scrollEndRef, short, useLive, useStickBottom,
  Glyph, QR, type DirProps,
} from './kit'
import './d.css'

export const D = {
  key: 'd',
  name: 'Quiet',
  title: 'D. Quiet',
  rationale: 'Familiar, calm and soft. It works the way people expect a messaging app to: bubbles, a large "Chats" title, a New chat button under the thumb, and settings as grouped lists. Warm neutrals and rounded panels lower the temperature, and one dusk-indigo accent marks what is yours. The typeface was designed for legibility; it tells 0/O and 1/l/I apart, which matters for hex addresses. A small flame appears on a message in its last minute.',
  type: 'Atkinson Hyperlegible Next for text and Atkinson Hyperlegible Mono for hex (both variable), self-hosted, about 80 KB together.',
  Component: AppD,
}

function Avatar({ address, size, theme }: { address: string; size: number; theme: DirProps['theme'] }) {
  return <span className="d-avatar" style={{ width: size, height: size }}><Glyph address={address} size={size} theme={theme} /></span>
}

function Hex({ address }: { address: string }) {
  return <span className="d-hex" aria-label={address}>{chunks(address).map((c, i) => <span key={i}>{c}</span>)}</span>
}

function ListPanel({ s, set, wide, theme }: DirProps) {
  const [confirm, setConfirm] = useState<string | null>(null)
  return (
    <nav className="d-panel d-side">
      <div className="d-top">
        <button className="d-me" onClick={() => set({ overlay: 'share', shareTab: 'show' })} aria-label="Share your address">
          <Avatar address={SELF} size={32} theme={theme} />
          {wide && <span><b>0xChat</b><small>{short(SELF)}</small></span>}
          <i className={`d-live ${s.trouble ? 'off' : ''}`} title={s.trouble ? 'Reconnecting' : 'Live'} />
        </button>
        <span className="d-spacer" />
        <button className="d-icon" aria-label="Share your address" onClick={() => set({ overlay: 'share', shareTab: 'show' })}><QrCode size={20} /></button>
        <button className="d-icon" aria-label="Settings" onClick={() => set({ overlay: 'settings' })}><Settings size={20} /></button>
        <a className="d-icon" href="#" aria-label="Help"><CircleHelp size={20} /></a>
      </div>
      {s.install && (
        <div className="d-card d-install"><span><b>Install 0xChat</b><small>Open it from your home screen like any app.</small></span><button className="d-pill accent">Install</button><button className="d-icon" aria-label="Dismiss"><X size={18} /></button></div>
      )}
      <div className="d-titlerow">
        <h1>Chats</h1>
        {wide && !s.emptyList && <button className="d-pill" onClick={() => set({ newConv: true })}><Plus size={18} />New chat</button>}
      </div>
      {s.emptyList ? (
        <div className="d-empty">
          <Avatar address={SELF} size={64} theme={theme} />
          <h2>{COPY.emptyListTitle}</h2>
          <p>{COPY.emptyListBody}</p>
          <button className="d-pill accent big" onClick={() => set({ overlay: 'share', shareTab: 'show' })}><QrCode size={18} />Share your address</button>
          <button className="d-pill big" onClick={() => set({ newConv: true })}>Start a chat</button>
        </div>
      ) : (
        <ul className="d-list">
          {CONVS.map(c => (
            <li key={c.address} className={`${s.active === c.address ? 'active' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => set({ active: c.address, newConv: false })}>
              <Avatar address={c.address} size={46} theme={theme} />
              <span className="d-who">
                <b>{c.label ?? <span className="d-mono">{short(c.address)}</span>}</b>
                <small>{c.stale ? 'No messages' : c.label ? <span className="d-mono">{short(c.address)}</span> : 'No name yet'}</small>
              </span>
              <span className="d-when"><time>{c.when}</time>{c.unread && <i aria-label="Unread" />}</span>
              {confirm === c.address ? (
                <button className="d-pill danger small" onClick={(e) => { e.stopPropagation(); setConfirm(null) }}>Remove</button>
              ) : (
                <button className="d-icon d-rm" aria-label="Remove chat" onClick={(e) => { e.stopPropagation(); setConfirm(c.address) }}><X size={18} /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!wide && !s.emptyList && <button className="d-fab" onClick={() => set({ newConv: true })}><Plus size={20} />New chat</button>}
    </nav>
  )
}

function ChatPanel({ s, set, wide, theme }: DirProps) {
  const conv = convOf(s.active!)
  const msgs = useLive(chatFor(s))
  const ref = useStickBottom(msgs.length)
  const name = nameOf(conv)
  return (
    <section className="d-panel d-chat">
      <header className="d-chat-head">
        {!wide && <button className="d-icon" aria-label="Back" onClick={() => set({ active: null })}><ArrowLeft size={22} /></button>}
        <Avatar address={conv.address} size={40} theme={theme} />
        {s.renaming ? (
          <form className="d-rename" onSubmit={(e) => { e.preventDefault(); set({ renaming: false }) }}>
            <input defaultValue="Kasia" aria-label="Name" />
            <button className="d-icon accent" aria-label="Save"><Check size={20} /></button>
            <button type="button" className="d-icon" aria-label="Cancel" onClick={() => set({ renaming: false })}><X size={20} /></button>
          </form>
        ) : (
          <>
            <button className="d-title" onClick={() => set({ renaming: true })}>
              <b className={conv.label ? '' : 'd-mono'}>{name}</b>
              <small>{conv.label ? <span className="d-mono">{short(conv.address)}</span> : 'Tap to add a name'}</small>
            </button>
            <button className="d-icon" aria-label="Copy address"><Copy size={20} /></button>
            {s.clearConfirm ? (
              <button className="d-pill danger small" onClick={() => set({ clearConfirm: false })}>Clear for both?</button>
            ) : (
              <button className="d-icon" aria-label="Clear chat" onClick={() => set({ clearConfirm: true })}><Trash2 size={20} /></button>
            )}
          </>
        )}
      </header>
      {s.trouble && <div className="d-reconnect" role="status"><RotateCw size={14} />Reconnecting…</div>}
      <div className="d-log" role="log" ref={ref}>
        <div className="d-grow" />
        {s.trouble && (
          <div className="d-card d-notice" role="alert">
            <b>{COPY.couldNotOpen}</b><span>{COPY.couldNotOpenDetail}</span>
            <button className="d-pill small">Try again</button>
          </div>
        )}
        {msgs.length === 0 ? (
          <div className="d-card d-intro">
            <Lock size={20} />
            <b>{COPY.emptyChatTitle}</b>
            <p>{COPY.emptyChatBody}</p>
          </div>
        ) : (
          <div className="d-older">
            {s.trouble && <span className="d-err">{COPY.olderError}</span>}
            <button className="d-pill small">{s.trouble ? 'Try again' : 'Load older messages'}</button>
          </div>
        )}
        {msgs.map((m, i) => {
          const prev = msgs[i - 1], next = msgs[i + 1]
          const first = !prev || prev.mine !== m.mine || !!m.day
          const last = !next || next.mine !== m.mine || !!next.day
          const burning = !!m.total && m.remaining <= 60
          return (
            <div key={m.id} className="d-item">
              {m.day && <div className="d-day"><span>{m.day}</span></div>}
              <div className={`d-bubble ${m.mine ? 'mine' : ''} ${first ? 'first' : ''} ${last ? 'last' : ''} ${burning ? 'burning' : ''} ${m.leaving ? 'leaving' : ''}`}>
                <p>{m.text.split(/(https?:\/\/\S+)/).map((p, k) => k % 2 ? <a key={k} href="#">{p}</a> : p)}</p>
                <span className="d-meta" title={m.total ? `Disappears in ${fmtLeft(m.remaining)}` : 'Not opened yet'}>
                  {m.time}
                  {m.total ? <span className="d-left">{burning ? <Flame size={13} /> : <Timer size={13} />}{fmtLeft(m.remaining)}</span> : <span className="d-left"><Check size={13} />{COPY.notOpened}</span>}
                </span>
              </div>
            </div>
          )
        })}
      </div>
      {s.departed ? <div className="d-card d-departed" role="status">{COPY.departed(name)}</div> : <ComposerD s={s} set={set} name={name} />}
    </section>
  )
}

function ComposerD({ s, set, name }: Pick<DirProps, 's' | 'set'> & { name: string }) {
  const [draft, setDraft] = useState('')
  const lifetime = s.lifetime ?? '30m'
  const short = ['5s', '10s', '30s', '1m'].includes(lifetime)
  return (
    <form className="d-composer" onSubmit={(e) => { e.preventDefault(); setDraft('') }}>
      <div className="d-compose-box">
        <label className={`d-chip ${short ? 'short' : ''}`} title={`Your messages disappear ${LIFETIME_WORDS[lifetime]} after they’re opened`}>
          {short ? <Flame size={15} /> : <Timer size={15} />}{lifetime}
          <select value={lifetime} onChange={(e) => set({ lifetime: (e.target as HTMLSelectElement).value })} aria-label="Message lifetime">
            {LIFETIMES.map(l => <option key={l} value={l}>{LIFETIME_WORDS[l]}</option>)}
          </select>
        </label>
        <textarea rows={1} placeholder="Message" value={draft} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} aria-label={`Message ${name}`} />
      </div>
      <button className="d-send" disabled={!draft.trim()} aria-label="Send"><Send size={19} /></button>
    </form>
  )
}

function SheetD({ title, wide, onClose, action, children, kind = 'page' }: { title: string; wide: boolean; onClose: () => void; action?: string; children: any; kind?: 'page' | 'bottom' }) {
  return (
    <div className={`d-scrim ${!wide && kind === 'bottom' ? 'bottom' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`d-sheet ${wide ? 'dialog' : kind}`} role="dialog" aria-label={title}>
        {!wide && kind === 'bottom' && <span className="d-grabber" aria-hidden="true" />}
        <header className="d-sheet-head">
          <h2>{title}</h2>
          <button className="d-done" onClick={onClose}>{action ?? 'Done'}</button>
        </header>
        {children}
      </div>
    </div>
  )
}

function Row({ label, value, children, onClick, danger }: { label: string; value?: any; children?: any; onClick?: () => void; danger?: boolean }) {
  return (
    <div className={`d-row ${onClick ? 'tap' : ''} ${danger ? 'danger' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}>
      <span>{label}</span>
      {value !== undefined && <span className="d-value">{value}</span>}
      {children}
    </div>
  )
}

function SettingsD({ s, set, wide, theme }: DirProps) {
  const [showKey, setShowKey] = useState(false)
  const [notify, setNotify] = useState(true)
  const lifetime = s.lifetime ?? '30m'
  return (
    <SheetD title="Settings" wide={wide} onClose={() => set({ overlay: null })}>
      <div className="d-settings" ref={scrollEndRef(s.scrollEnd)}>
        <div className="d-profile">
          <Avatar address={SELF} size={64} theme={theme} />
          <Hex address={SELF} />
          <div className="d-pills">
            <button className="d-pill"><Copy size={16} />Copy</button>
            <button className="d-pill"><Link size={16} />Link</button>
            <button className="d-pill" onClick={() => set({ overlay: 'share', shareTab: 'show' })}><QrCode size={16} />QR code</button>
          </div>
        </div>

        <h3>Messages</h3>
        <div className="d-group">
          <label className="d-row tap">
            <span>Default lifetime</span>
            <span className="d-value">{LIFETIME_WORDS[lifetime] ?? 'Remember last'}<ChevronRight size={18} /></span>
            <select className="d-overlay-select" value={lifetime} onChange={(e) => set({ lifetime: (e.target as HTMLSelectElement).value })}>
              <option value="remember">Remember last</option>
              {LIFETIMES.map(l => <option key={l} value={l}>{LIFETIME_WORDS[l]}</option>)}
            </select>
          </label>
        </div>
        <p className="d-foot">{COPY.lifetimeHelp}</p>

        <h3>Notifications</h3>
        <div className="d-group">
          <Row label="New message alerts">
            {s.notifBlocked ? <span className="d-value">Blocked</span> : <button role="switch" aria-checked={notify} aria-label="New message alerts" className="d-switch" onClick={() => setNotify(!notify)}><i /></button>}
          </Row>
        </div>
        <p className="d-foot">{s.notifBlocked ? COPY.notifBlocked : COPY.notifHelp}</p>

        <h3>Your key</h3>
        <div className="d-group">
          <div className="d-row key">
            <span className="d-mono d-keytext">{showKey ? PRIVATE_KEY : '•••• •••• •••• •••• ••••'}</span>
            <button className="d-icon" aria-label={showKey ? 'Hide private key' : 'Show private key'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={20} /> : <Eye size={20} />}</button>
          </div>
          <Row label="Copy private key" onClick={() => {}}><Copy size={18} className="d-trail" /></Row>
          <Row label="Use another key" onClick={() => set({ importPreview: !s.importPreview })}><ChevronRight size={18} className="d-trail" /></Row>
          {s.importPreview && (
            <div className="d-import">
              <input type="password" defaultValue={PRIVATE_KEY} aria-label="Private key to import" />
              <span className="d-small">This key opens</span>
              <div className="d-idline"><Avatar address={IMPORTED} size={32} theme={theme} /><Hex address={IMPORTED} /></div>
              <div className="d-pills"><button className="d-pill accent">Switch to this account</button><button className="d-pill" onClick={() => set({ importPreview: false })}>Cancel</button></div>
            </div>
          )}
        </div>
        <p className="d-foot">{COPY.keyHelp}</p>

        <div className="d-group danger">
          {s.burnConfirm ? (
            <div className="d-burn" role="alert">
              <Flame size={22} />
              <p>{COPY.burnConfirm}</p>
              <button className="d-pill danger-fill big">Burn permanently</button>
              <button className="d-pill big" onClick={() => set({ burnConfirm: false })}>Keep my identity</button>
            </div>
          ) : (
            <Row label="Burn identity…" danger onClick={() => set({ burnConfirm: true })} />
          )}
        </div>
        <p className="d-foot">{COPY.burnHelp}</p>
        <p className="d-version">0xChat 0.5.5 · <a href="#">Help and docs</a></p>
      </div>
    </SheetD>
  )
}

function ShareD({ s, set, wide }: DirProps) {
  const scan = s.shareTab === 'scan'
  return (
    <SheetD title="Share" wide={wide} onClose={() => set({ overlay: null })} kind="bottom">
      <div className="d-share">
        <div className="d-seg" role="tablist">
          <button role="tab" aria-selected={!scan} onClick={() => set({ shareTab: 'show' })}>My code</button>
          <button role="tab" aria-selected={scan} onClick={() => set({ shareTab: 'scan' })}><Camera size={16} />Scan</button>
        </div>
        {scan ? <div className="d-camera">Point your camera at a 0xChat code</div> : (
          <>
            <div className="d-qr"><QR address={SELF} size={208} /></div>
            <Hex address={SELF} />
            <div className="d-pills"><button className="d-pill accent big"><Copy size={18} />Copy address</button><button className="d-pill big"><Link size={18} />Copy link</button></div>
          </>
        )}
      </div>
    </SheetD>
  )
}

function NewChatD({ set, wide }: DirProps) {
  return (
    <SheetD title="New chat" wide={wide} onClose={() => set({ newConv: false })} action="Cancel" kind="bottom">
      <div className="d-newchat">
        <label className="d-field"><span>Their address</span><input className="d-mono" defaultValue={NEWBIE} spellcheck={false} /></label>
        <label className="d-field"><span>Name, if you like</span><input placeholder="What you call them" /></label>
        <p className="d-err" role="alert">{COPY.unreachableNote}</p>
        <div className="d-pills">
          <button className="d-pill accent big">Start chat</button>
          <button className="d-pill big" onClick={() => set({ overlay: 'share', shareTab: 'scan', newConv: false })}><Camera size={18} />Scan QR</button>
        </div>
      </div>
    </SheetD>
  )
}

function AppD(p: DirProps) {
  const { s, wide } = p
  const inChat = !!s.active
  return (
    <div className={`d-app ${wide ? 'is-wide' : 'is-narrow'}`}>
      {s.trouble && <div className="d-update" role="alert"><span>{COPY.update}</span><button className="d-pill accent small">Reload</button></div>}
      <div className="d-main">
        {(wide || !inChat) && <ListPanel {...p} />}
        {(wide || inChat) && (inChat ? <ChatPanel {...p} /> : <section className="d-panel d-chat d-none"><Lock size={22} /><p>{COPY.tagline}</p></section>)}
      </div>
      {s.newConv && <NewChatD {...p} />}
      {s.overlay === 'settings' && <SettingsD {...p} />}
      {s.overlay === 'share' && <ShareD {...p} />}
      {s.trouble && <div className="d-toast" role="alert">Couldn’t send. Check your connection and try again.<button className="d-icon" aria-label="Dismiss"><X size={18} /></button></div>}
    </div>
  )
}
