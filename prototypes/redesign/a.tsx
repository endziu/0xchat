// PROTOTYPE — Direction A, "Refined": the current app's DNA (black, neutral,
// one amber accent, rule-marked transcript) with a real type scale, sans text,
// mono only for machine values, and settings grouped by what people do.
import { useState } from 'preact/hooks'
import { ArrowLeft, Camera, Check, CircleHelp, Copy, Eye, EyeOff, Link, Plus, QrCode, RotateCw, Send, Settings, Timer, Trash2, UserX, X } from 'lucide-preact'
import {
  CONVS, COPY, IMPORTED, LIFETIMES, LIFETIME_WORDS, NEWBIE, PRIVATE_KEY, SELF, chatFor, convOf, fmtLeft, nameOf, scrollEndRef, short, useLive, useStickBottom,
  Glyph, QR, type DirProps, type Live,
} from './kit'
import './a.css'

export const A = {
  key: 'a',
  name: 'Refined',
  title: 'A. Refined current',
  rationale: 'Keep everything people already know: black, neutral greys, one amber accent and the rule-marked transcript. Change only what reads as unfinished. Text moves to the system sans, and mono is kept for addresses, times and countdowns. Labels lose the tracked caps. A five-step type scale and an 8px rhythm replace the uniform 14px. Copy, link and QR collapse into one Share sheet, and settings are grouped by what people actually do.',
  type: 'System UI sans (SF / Roboto / Segoe) for text, system mono for hex and numbers. Nothing to download.',
  Component: AppA,
}

function Ring({ m }: { m: Live }) {
  // Hollow and dashed until opened; then it drains with the lifetime.
  const r = 5.5, c = 2 * Math.PI * r
  const frac = m.total ? Math.max(0, m.remaining / m.total) : 1
  return (
    <svg className="a-ring" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r={r} className="a-ring-track" style={m.total ? undefined : { strokeDasharray: '2 2' }} />
      {m.total && <circle cx="7" cy="7" r={r} className="a-ring-fill" style={{ strokeDasharray: `${c * frac} ${c}` }} />}
    </svg>
  )
}

function TopBar({ s, set, wide, theme }: DirProps) {
  return (
    <header className="a-bar">
      <a className="a-brand" href="#" onClick={(e) => { e.preventDefault(); set({ active: null }) }}>
        {wide ? <span className="a-hex" aria-hidden="true">⬡</span> : <Glyph address={SELF} size={22} theme={theme} />}
        0xChat
      </a>
      <span className={`a-live ${s.trouble ? 'off' : ''}`} title={s.trouble ? 'Reconnecting' : 'Live'}><i />{wide && (s.trouble ? 'Reconnecting' : 'Live')}</span>
      <span className="a-spacer" />
      {wide && (
        <button className="a-me" onClick={() => set({ overlay: 'share', shareTab: 'show' })} title="Share your address">
          <Glyph address={SELF} size={20} theme={theme} />
          <span className="mono">{short(SELF)}</span>
        </button>
      )}
      <button className="a-icon" aria-label="Share your address" title="Share your address" onClick={() => set({ overlay: 'share', shareTab: 'show' })}><QrCode size={18} /></button>
      <button className="a-icon" aria-label="Settings" title="Settings" onClick={() => set({ overlay: 'settings' })}><Settings size={18} /></button>
      <a className="a-icon" href="#" aria-label="Help" title="Help"><CircleHelp size={18} /></a>
    </header>
  )
}

function Sidebar({ s, set, theme }: DirProps) {
  const [confirm, setConfirm] = useState<string | null>(null)
  return (
    <nav className="a-side">
      <div className="a-side-head">
        <h2>Conversations</h2>
        <button className="a-ghost" onClick={() => set({ newConv: !s.newConv })} aria-expanded={!!s.newConv}><Plus size={16} />New</button>
      </div>
      {s.newConv && (
        <div className="a-new">
          <label className="a-field"><span>Address</span><input className="mono" defaultValue={NEWBIE} spellcheck={false} /></label>
          <label className="a-field"><span>Name <em>(optional)</em></span><input placeholder="What you call them" /></label>
          <p className="a-error" role="alert">{COPY.unreachableNote}</p>
          <div className="a-row">
            <button className="a-primary">Start</button>
            <button className="a-ghost" aria-label="Scan QR code" title="Scan QR code" onClick={() => set({ overlay: 'share', shareTab: 'scan' })}><Camera size={16} />Scan</button>
            <span className="a-spacer" />
            <button className="a-ghost" onClick={() => set({ newConv: false })}>Cancel</button>
          </div>
        </div>
      )}
      {s.emptyList ? (
        <div className="a-empty">
          <Glyph address={SELF} size={44} theme={theme} />
          <h3>{COPY.emptyListTitle}</h3>
          <p>{COPY.emptyListBody}</p>
          <button className="a-primary" onClick={() => set({ overlay: 'share', shareTab: 'show' })}><QrCode size={16} />Share your address</button>
          <button className="a-ghost" onClick={() => set({ newConv: true })}>Start a conversation</button>
        </div>
      ) : (
        <ul className="a-list">
          {CONVS.map(c => (
            <li key={c.address} className={`${s.active === c.address ? 'active' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => set({ active: c.address, newConv: false })}>
              <i className="a-dot" aria-label={c.unread ? 'Unread' : undefined} />
              <Glyph address={c.address} size={28} theme={theme} />
              <span className="a-who">
                <span className={c.label ? 'name' : 'name mono'}>{nameOf(c)}</span>
                {c.stale && <small>No messages</small>}
              </span>
              <time className="mono">{c.when}</time>
              <button className={`a-icon a-remove ${confirm === c.address ? 'confirm' : ''}`} onClick={(e) => { e.stopPropagation(); setConfirm(confirm === c.address ? null : c.address) }} aria-label="Remove conversation" title="Remove and forget the name">
                {confirm === c.address ? 'Remove?' : <UserX size={16} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}

function ChatPane({ s, set, wide, theme }: DirProps) {
  const conv = convOf(s.active!)
  const msgs = useLive(chatFor(s))
  const name = nameOf(conv)
  const logRef = useStickBottom(msgs.length)
  return (
    <section className="a-pane">
      <header className="a-chat-head">
        {!wide && <button className="a-icon" aria-label="Back" onClick={() => set({ active: null })}><ArrowLeft size={20} /></button>}
        <Glyph address={conv.address} size={32} theme={theme} />
        {s.renaming ? (
          <form className="a-rename" onSubmit={(e) => { e.preventDefault(); set({ renaming: false }) }}>
            <input defaultValue="Kasia" aria-label="Name" />
            <button className="a-icon" aria-label="Save name"><Check size={18} /></button>
            <button type="button" className="a-icon" aria-label="Cancel" onClick={() => set({ renaming: false })}><X size={18} /></button>
          </form>
        ) : (
          <>
            <button className="a-title" onClick={() => set({ renaming: true })} title={conv.label ? 'Rename' : 'Add a name'}>
              <span className={conv.label ? '' : 'mono'}>{name}</span>
              <small className="mono">{conv.label ? (wide ? conv.address : short(conv.address)) : 'Add a name'}</small>
            </button>
            <button className="a-icon" aria-label="Copy address" title="Copy address"><Copy size={18} /></button>
            <button className={`a-icon ${s.clearConfirm ? 'a-confirm' : ''}`} onClick={() => set({ clearConfirm: !s.clearConfirm })} aria-label="Clear conversation" title="Clear for both of you">
              {s.clearConfirm ? 'Clear for both?' : <Trash2 size={18} />}
            </button>
          </>
        )}
      </header>
      {s.trouble && (
        <div className="a-alert" role="alert">
          <strong>{COPY.couldNotOpen}</strong>
          <span>{COPY.couldNotOpenDetail}</span>
          <button className="a-ghost"><RotateCw size={14} />Retry</button>
        </div>
      )}
      <div className="a-log" role="log" ref={logRef}>
        <div className="a-grow" />
        {msgs.length === 0 ? (
          <div className="a-empty">
            <h3>{COPY.emptyChatTitle}</h3>
            <p>{COPY.emptyChatBody}</p>
          </div>
        ) : (
          <div className="a-older">
            {s.trouble && <span className="a-error">{COPY.olderError}</span>}
            <button className="a-ghost small">{s.trouble ? 'Retry' : 'Load older messages'}</button>
          </div>
        )}
        {msgs.map((m, i) => {
          const prev = msgs[i - 1]
          const start = !prev || prev.mine !== m.mine || !!m.day
          const sameMinute = !start && prev.time === m.time
          return (
            <div key={m.id}>
              {m.day && <div className="a-day"><span>{m.day}</span></div>}
              <article className={`a-msg ${m.mine ? 'mine' : ''} ${start ? 'start' : ''} ${m.leaving ? 'leaving' : ''}`}>
                <time className={`mono ${sameMinute ? 'dup' : ''}`}>{m.time}</time>
                <div className="a-body-col">
                  {start && <span className="a-sender">{m.mine ? 'You' : name}</span>}
                  <p>{linkify(m.text)}</p>
                </div>
                <span className={`a-left mono ${m.total && m.remaining <= 60 ? 'soon' : ''}`} title={m.total ? `Disappears in ${fmtLeft(m.remaining)}` : 'Not opened yet'}>
                  <Ring m={m} />{m.total ? fmtLeft(m.remaining) : COPY.notOpened}
                </span>
              </article>
            </div>
          )
        })}
      </div>
      {s.departed ? (
        <p className="a-departed" role="status">{COPY.departed(name)}</p>
      ) : (
        <Composer s={s} set={set} name={name} />
      )}
    </section>
  )
}

function Composer({ s, set, name }: Pick<DirProps, 's' | 'set'> & { name: string }) {
  const [draft, setDraft] = useState('')
  const lifetime = s.lifetime ?? '30m'
  const short = ['5s', '10s', '30s', '1m'].includes(lifetime)
  return (
    <form className="a-composer" onSubmit={(e) => { e.preventDefault(); setDraft('') }}>
      <div className="a-compose-box">
        <label className={`a-chip ${short ? 'short' : ''}`} title={`Your messages disappear ${LIFETIME_WORDS[lifetime]} after they’re opened`}>
          <Timer size={14} />{lifetime}
          <select value={lifetime} onChange={(e) => set({ lifetime: (e.target as HTMLSelectElement).value })} aria-label="Message lifetime">
            {LIFETIMES.map(l => <option key={l} value={l}>{LIFETIME_WORDS[l]}</option>)}
          </select>
        </label>
        <textarea rows={1} placeholder={`Message ${name}`} value={draft} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} />
        <button className="a-send" disabled={!draft.trim()} aria-label="Send"><Send size={18} /></button>
      </div>
    </form>
  )
}

function linkify(text: string) {
  return text.split(/(https?:\/\/\S+)/).map((part, i) => i % 2 ? <a key={i} href="#">{part}</a> : part)
}

function Sheet({ title, onClose, children, wide, size = 'md' }: { title: string; onClose: () => void; children: any; wide: boolean; size?: 'md' | 'sm' }) {
  return (
    <div className="a-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`a-sheet ${wide ? 'dialog' : 'full'} ${size}`} role="dialog" aria-label={title}>
        <header className="a-sheet-head">
          <h2>{title}</h2>
          <button className="a-icon" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>
        {children}
      </div>
    </div>
  )
}

function SettingsA({ s, set, wide, theme }: DirProps) {
  const [showKey, setShowKey] = useState(false)
  const [notify, setNotify] = useState(true)
  const lifetime = s.lifetime ?? '30m'
  return (
    <Sheet title="Settings" onClose={() => set({ overlay: null })} wide={wide}>
      <div className="a-settings" ref={scrollEndRef(s.scrollEnd)}>
        <section>
          <h3>Your address</h3>
          <div className="a-idcard">
            <Glyph address={SELF} size={40} theme={theme} />
            <p className="mono">{SELF}</p>
          </div>
          <div className="a-row">
            <button className="a-ghost"><Copy size={16} />Copy address</button>
            <button className="a-ghost"><Link size={16} />Copy link</button>
            <button className="a-ghost" onClick={() => set({ overlay: 'share', shareTab: 'show' })}><QrCode size={16} />QR code</button>
          </div>
        </section>
        <section>
          <h3>Messages</h3>
          <label className="a-setting">
            <span><strong>Default lifetime</strong><small>{COPY.lifetimeHelp}</small></span>
            <select value={lifetime} onChange={(e) => set({ lifetime: (e.target as HTMLSelectElement).value })}>
              <option value="remember">Remember last</option>
              {LIFETIMES.map(l => <option key={l} value={l}>{LIFETIME_WORDS[l]}</option>)}
            </select>
          </label>
        </section>
        <section>
          <h3>Notifications</h3>
          <div className="a-setting">
            <span id="a-notif"><strong>New message alerts</strong><small>{s.notifBlocked ? COPY.notifBlocked : COPY.notifHelp}</small></span>
            {!s.notifBlocked && (
              <button role="switch" aria-checked={notify} aria-labelledby="a-notif" className="a-switch" onClick={() => setNotify(!notify)}><i /></button>
            )}
          </div>
        </section>
        <section>
          <h3>Your key</h3>
          <p className="a-help">{COPY.keyHelp}</p>
          <div className="a-keyfield">
            <input className="mono" readOnly type={showKey ? 'text' : 'password'} value={PRIVATE_KEY} aria-label="Private key" />
            <button className="a-ghost" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}{showKey ? 'Hide' : 'Show'}</button>
            <button className="a-ghost"><Copy size={16} />Copy</button>
          </div>
          <h4>Use another key</h4>
          <p className="a-help">{COPY.importHelp}</p>
          {s.importPreview ? (
            <div className="a-preview">
              <span className="a-help">This key opens</span>
              <div className="a-idcard"><Glyph address={IMPORTED} size={32} theme={theme} /><p className="mono">{IMPORTED}</p></div>
              <div className="a-row">
                <button className="a-primary">Switch to this account</button>
                <button className="a-ghost" onClick={() => set({ importPreview: false })}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="a-keyfield">
              <input className="mono" type="password" placeholder="Paste a private key (0x…)" aria-label="Private key to import" />
              <button className="a-ghost" onClick={() => set({ importPreview: true })}>Continue</button>
            </div>
          )}
        </section>
        <section className="a-danger">
          <h3>Burn identity</h3>
          {s.burnConfirm ? (
            <div role="alert">
              <p className="a-help strong">{COPY.burnConfirm}</p>
              <div className="a-row">
                <button className="a-destroy">Burn permanently</button>
                <button className="a-ghost" onClick={() => set({ burnConfirm: false })}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="a-setting">
              <span><small>{COPY.burnHelp}</small></span>
              <button className="a-ghost danger" onClick={() => set({ burnConfirm: true })}>Burn identity…</button>
            </div>
          )}
        </section>
        <footer className="a-about"><span className="mono">0xChat 0.5.5</span><a href="#">Help and docs</a></footer>
      </div>
    </Sheet>
  )
}

function ShareA({ s, set, wide }: DirProps) {
  const scan = s.shareTab === 'scan'
  return (
    <Sheet title="Share your address" onClose={() => set({ overlay: null })} wide={wide} size="sm">
      <div className="a-share">
        <div className="a-seg" role="tablist">
          <button role="tab" aria-selected={!scan} onClick={() => set({ shareTab: 'show' })}><QrCode size={16} />My code</button>
          <button role="tab" aria-selected={scan} onClick={() => set({ shareTab: 'scan' })}><Camera size={16} />Scan</button>
        </div>
        {scan ? (
          <div className="a-camera"><span>Point the camera at a 0xChat QR code</span></div>
        ) : (
          <>
            <div className="a-qr"><QR address={SELF} size={196} /></div>
            <p className="mono a-addr">{SELF}</p>
            <div className="a-row center">
              <button className="a-ghost"><Copy size={16} />Copy address</button>
              <button className="a-ghost"><Link size={16} />Copy link</button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  )
}

function AppA(p: DirProps) {
  const { s, set, wide } = p
  const inChat = !!s.active
  return (
    <div className={`a-app ${wide ? 'is-wide' : 'is-narrow'}`}>
      {(wide || !inChat) && <TopBar {...p} />}
      {s.trouble && (
        <div className="a-update" role="alert"><span>{COPY.update}</span><button className="a-primary small">Reload</button></div>
      )}
      {s.trouble && <div className="a-reconnecting" role="status">Reconnecting…</div>}
      {s.install && (
        <aside className="a-install"><span>Install 0xChat as an app</span><button className="a-ghost small">Install</button><button className="a-icon" aria-label="Dismiss"><X size={16} /></button></aside>
      )}
      <div className="a-main">
        {(wide || !inChat) && <Sidebar {...p} />}
        {(wide || inChat) && (inChat ? <ChatPane {...p} /> : (
          <section className="a-pane a-none"><p>{COPY.tagline}</p></section>
        ))}
      </div>
      {s.overlay === 'settings' && <SettingsA {...p} />}
      {s.overlay === 'share' && <ShareA {...p} />}
      {s.trouble && <div className="a-toast" role="alert"><span>Couldn’t send. Check your connection and try again.</span><button className="a-icon" aria-label="Dismiss"><X size={16} /></button></div>}
    </div>
  )
}
