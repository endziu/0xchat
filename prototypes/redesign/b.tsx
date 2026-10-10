// PROTOTYPE — Direction B, "Readout": the 0x identity taken seriously. One
// monospace family, hairlines instead of boxes, no bubbles. Messages are a log;
// each one carries a fuse that shortens as its lifetime burns. Addresses are
// always readable: full, in groups of four.
import { useState } from 'preact/hooks'
import { ArrowLeft, Camera, Check, CircleHelp, Copy, Eye, EyeOff, QrCode, Settings, Trash2, X } from 'lucide-preact'
import {
  CONVS, COPY, IMPORTED, LIFETIMES, LIFETIME_WORDS, NEWBIE, PRIVATE_KEY, SELF, chatFor, chunks, convOf, fmtLeft, nameOf, scrollEndRef, short, useLive, useStickBottom,
  Glyph, QR, type DirProps, type Live,
} from './kit'
import './b.css'

export const B = {
  key: 'b',
  name: 'Readout',
  title: 'B. Readout',
  rationale: 'Lean into what 0xChat is: an address-based, end-to-end encrypted channel. One monospace family carries everything, so hex, times and text share a grid and line up. Hairlines replace boxes, and the transcript is a log rather than bubbles. Each message has a fuse, a hairline that shortens as its lifetime burns. Addresses are shown in full, in groups of four with alternating tone, so they can be checked by eye. On desktop a third column shows facts about the conversation.',
  type: 'IBM Plex Mono (400, 500, 600), self-hosted, about 90 KB with Polish characters. Its slab details keep long text readable.',
  Component: AppB,
}

export function Hex({ address, wrap }: { address: string; wrap?: boolean }) {
  // Groups of four with alternating tone: easy to compare against another screen.
  return (
    <span className={`b-hex ${wrap ? 'wrap' : ''}`} aria-label={address}>
      {chunks(address).map((c, i) => <span key={i} className={i % 2 ? 'odd' : ''}>{c}</span>)}
    </span>
  )
}

function Fuse({ m }: { m: Live }) {
  const frac = m.total ? Math.max(0, m.remaining / m.total) : 1
  return <span className={`b-fuse ${m.total ? '' : 'sealed'} ${m.total && m.remaining <= 60 ? 'soon' : ''}`} style={{ '--frac': frac } as any} aria-hidden="true" />
}

function Bar({ s, set, wide, theme }: DirProps) {
  const conv = s.active ? convOf(s.active) : null
  return (
    <header className="b-bar">
      <button className="b-path" onClick={() => set({ active: null })}>
        <b>0xChat</b>
        {wide && conv && <><span className="b-sep">/</span><span>{nameOf(conv)}</span></>}
      </button>
      <span className={`b-live ${s.trouble ? 'off' : ''}`}>{s.trouble ? '○ reconnecting' : '● live'}</span>
      <span className="b-spacer" />
      {wide && <button className="b-me" onClick={() => set({ overlay: 'share', shareTab: 'show' })}><Glyph address={SELF} size={18} theme={theme} />{short(SELF)}</button>}
      <button className="b-icon" aria-label="Share your address" onClick={() => set({ overlay: 'share', shareTab: 'show' })}><QrCode size={17} /></button>
      <button className="b-icon" aria-label="Settings" aria-pressed={s.overlay === 'settings'} onClick={() => set({ overlay: s.overlay === 'settings' ? null : 'settings' })}><Settings size={17} /></button>
      <a className="b-icon" href="#" aria-label="Help"><CircleHelp size={17} /></a>
    </header>
  )
}

function List({ s, set, theme }: DirProps) {
  const [confirm, setConfirm] = useState<string | null>(null)
  return (
    <nav className="b-list-wrap">
      <div className="b-head">
        <span>Conversations <em>{s.emptyList ? 0 : CONVS.length}</em></span>
        <button className="b-btn" onClick={() => set({ newConv: !s.newConv })}>{s.newConv ? 'Cancel' : '+ New'}</button>
      </div>
      {s.newConv && (
        <div className="b-new">
          <label>Address<input defaultValue={NEWBIE} spellcheck={false} /></label>
          <label>Name, optional<input placeholder="what you call them" /></label>
          <p className="b-err" role="alert">! {COPY.unreachableNote}</p>
          <div className="b-actions">
            <button className="b-btn solid">Start</button>
            <button className="b-btn" onClick={() => set({ overlay: 'share', shareTab: 'scan' })}><Camera size={15} />Scan QR</button>
          </div>
        </div>
      )}
      {s.emptyList ? (
        <div className="b-empty">
          <p className="b-dim">{COPY.emptyListTitle}.</p>
          <p>{COPY.emptyListBody}</p>
          <div className="b-card"><span className="b-dim">Your address</span><Hex address={SELF} wrap /></div>
          <div className="b-actions">
            <button className="b-btn solid" onClick={() => set({ overlay: 'share', shareTab: 'show' })}><QrCode size={15} />Show QR</button>
            <button className="b-btn"><Copy size={15} />Copy address</button>
          </div>
        </div>
      ) : (
        <ul className="b-list">
          {CONVS.map(c => (
            <li key={c.address} className={`${s.active === c.address ? 'active' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => set({ active: c.address, newConv: false, overlay: null })}>
              <Glyph address={c.address} size={24} theme={theme} />
              <span className="b-name">{c.unread && <i aria-label="Unread">●</i>}{c.label ?? short(c.address)}</span>
              <time>{c.when}</time>
              <span className="b-sub">{c.stale ? 'no messages' : <Hex address={c.address} />}</span>
              <button className={`b-rm ${confirm === c.address ? 'confirm' : ''}`} onClick={(e) => { e.stopPropagation(); setConfirm(confirm === c.address ? null : c.address) }} aria-label="Remove conversation">
                {confirm === c.address ? 'remove?' : '×'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}

function Log({ s, set, wide, theme }: DirProps) {
  const conv = convOf(s.active!)
  const msgs = useLive(chatFor(s))
  const ref = useStickBottom(msgs.length)
  const name = nameOf(conv)
  return (
    <section className="b-pane">
      <header className="b-chat-head">
        {!wide && <button className="b-icon" aria-label="Back" onClick={() => set({ active: null })}><ArrowLeft size={18} /></button>}
        <Glyph address={conv.address} size={wide ? 28 : 26} theme={theme} />
        {s.renaming ? (
          <form className="b-rename" onSubmit={(e) => { e.preventDefault(); set({ renaming: false }) }}>
            <span className="b-prompt">name ›</span><input defaultValue="Kasia" aria-label="Name" />
            <button className="b-icon" aria-label="Save"><Check size={17} /></button>
            <button type="button" className="b-icon" aria-label="Cancel" onClick={() => set({ renaming: false })}><X size={17} /></button>
          </form>
        ) : (
          <>
            <button className="b-who" onClick={() => set({ renaming: true })}>
              <b>{conv.label ?? short(conv.address)}</b>
              <small>{conv.label ? short(conv.address) : 'add a name'}</small>
            </button>
            {!wide && (
              <>
                <button className="b-icon" aria-label="Copy address"><Copy size={17} /></button>
                <button className={`b-icon ${s.clearConfirm ? 'b-confirm' : ''}`} aria-label="Clear conversation" onClick={() => set({ clearConfirm: !s.clearConfirm })}>{s.clearConfirm ? 'clear both?' : <Trash2 size={17} />}</button>
              </>
            )}
          </>
        )}
      </header>
      {s.trouble && (
        <div className="b-notice" role="alert">
          <span><b>! {COPY.couldNotOpen}.</b> {COPY.couldNotOpenDetail}</span>
          <button className="b-btn">Retry</button>
        </div>
      )}
      <div className="b-log" role="log" ref={ref}>
        <div className="b-grow" />
        {msgs.length === 0 ? (
          <div className="b-empty">
            <p className="b-dim">{COPY.emptyChatTitle}.</p>
            <p>{COPY.emptyChatBody}</p>
          </div>
        ) : (
          <div className="b-older">
            {s.trouble ? <><span className="b-err">! {COPY.olderError}</span><button className="b-link">retry</button></> : <button className="b-link">↑ load older messages</button>}
          </div>
        )}
        {msgs.map((m, i) => {
          const prev = msgs[i - 1]
          const start = !prev || prev.mine !== m.mine || !!m.day
          return (
            <div key={m.id}>
              {m.day && <div className="b-day">{m.day}</div>}
              <article className={`b-msg ${m.mine ? 'mine' : ''} ${start ? 'start' : ''} ${m.leaving ? 'leaving' : ''}`}>
                <span className="b-gut">
                  <time>{m.time}</time>
                  <span className={`b-ttl ${m.total && m.remaining <= 60 ? 'soon' : ''}`}>{m.total ? fmtLeft(m.remaining) : 'sealed'}</span>
                </span>
                <div className="b-text">
                  {start && <span className="b-nick">{m.mine ? 'you' : name}</span>}
                  <p>{m.text.split(/(https?:\/\/\S+)/).map((p, k) => k % 2 ? <a key={k} href="#">{p}</a> : p)}</p>
                  <Fuse m={m} />
                </div>
              </article>
            </div>
          )
        })}
      </div>
      {s.departed ? (
        <p className="b-departed" role="status">— {COPY.departed(name)}</p>
      ) : (
        <ComposerB s={s} set={set} name={name} />
      )}
    </section>
  )
}

function ComposerB({ s, set, name }: Pick<DirProps, 's' | 'set'> & { name: string }) {
  const [draft, setDraft] = useState('')
  const lifetime = s.lifetime ?? '30m'
  const short = ['5s', '10s', '30s', '1m'].includes(lifetime)
  return (
    <form className="b-composer" onSubmit={(e) => { e.preventDefault(); setDraft('') }}>
      <span className="b-prompt" aria-hidden="true">›</span>
      <textarea rows={1} placeholder={`message ${name}`} value={draft} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} aria-label={`Message ${name}`} />
      <label className={`b-ttl-pick ${short ? 'short' : ''}`} title={`Your messages disappear ${LIFETIME_WORDS[lifetime]} after they’re opened`}>
        burns {lifetime}
        <select value={lifetime} onChange={(e) => set({ lifetime: (e.target as HTMLSelectElement).value })} aria-label="Message lifetime">
          {LIFETIMES.map(l => <option key={l} value={l}>{LIFETIME_WORDS[l]}</option>)}
        </select>
      </label>
      <button className="b-btn solid" disabled={!draft.trim()}>send ⏎</button>
    </form>
  )
}

function Inspector({ s, set, theme }: DirProps) {
  const conv = convOf(s.active!)
  return (
    <aside className="b-inspect">
      <Glyph address={conv.address} size={56} theme={theme} />
      <h3>{nameOf(conv)}</h3>
      <dl className="b-dl">
        <dt>Address</dt><dd><Hex address={conv.address} wrap /></dd>
        <dt>Encryption</dt><dd>End to end. Only you two hold the keys.</dd>
        <dt>Sender</dt><dd>Every message is signed and checked.</dd>
        <dt>Unopened</dt><dd>Deleted 24 hours after sending.</dd>
      </dl>
      <div className="b-col">
        <button className="b-btn"><Copy size={15} />Copy address</button>
        <button className="b-btn" onClick={() => set({ renaming: true })}>Rename</button>
        <button className={`b-btn danger ${s.clearConfirm ? 'armed' : ''}`} onClick={() => set({ clearConfirm: !s.clearConfirm })}>
          <Trash2 size={15} />{s.clearConfirm ? 'Tap again: clear for both of you' : 'Clear conversation'}
        </button>
      </div>
    </aside>
  )
}

function SettingsB({ s, set, wide, theme }: DirProps) {
  const [showKey, setShowKey] = useState(false)
  const [notify, setNotify] = useState(true)
  const lifetime = s.lifetime ?? '30m'
  return (
    <section className={`b-settings ${wide ? 'page' : 'sheet'}`} aria-label="Settings">
      <header className="b-chat-head">
        <b className="b-title">Settings</b>
        <span className="b-spacer" />
        <button className="b-icon" aria-label="Close settings" onClick={() => set({ overlay: null })}><X size={18} /></button>
      </header>
      <div className="b-scroll" ref={scrollEndRef(s.scrollEnd)}>
        <div className="b-group">
          <h3>Identity</h3>
          <div className="b-kv"><span>Address</span><div><div className="b-idline"><Glyph address={SELF} size={32} theme={theme} /><Hex address={SELF} wrap /></div>
            <div className="b-actions"><button className="b-btn"><Copy size={15} />Copy</button><button className="b-btn">Copy link</button><button className="b-btn" onClick={() => set({ overlay: 'share', shareTab: 'show' })}><QrCode size={15} />QR</button></div></div></div>
        </div>
        <div className="b-group">
          <h3>Messages</h3>
          <label className="b-kv"><span>Default lifetime</span><div>
            <select value={lifetime} onChange={(e) => set({ lifetime: (e.target as HTMLSelectElement).value })}>
              <option value="remember">remember last</option>
              {LIFETIMES.map(l => <option key={l} value={l}>{LIFETIME_WORDS[l]}</option>)}
            </select>
            <p className="b-dim">{COPY.lifetimeHelp}</p></div></label>
          <div className="b-kv"><span id="b-notif">Alerts</span><div>
            {s.notifBlocked ? <p className="b-err">! {COPY.notifBlocked}</p> : (
              <button className="b-toggle" role="switch" aria-checked={notify} aria-labelledby="b-notif" onClick={() => setNotify(!notify)}>
                <span className={notify ? '' : 'on'}>off</span><span className={notify ? 'on' : ''}>on</span>
              </button>
            )}
            <p className="b-dim">{COPY.notifHelp}</p></div></div>
        </div>
        <div className="b-group">
          <h3>Key</h3>
          <div className="b-kv"><span>Private key</span><div>
            <code className="b-key">{showKey ? PRIVATE_KEY : '0x' + '•'.repeat(24)}</code>
            <div className="b-actions"><button className="b-btn" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}{showKey ? 'Hide' : 'Reveal'}</button><button className="b-btn"><Copy size={15} />Copy</button></div>
            <p className="b-dim">{COPY.keyHelp}</p></div></div>
          <div className="b-kv"><span>Use another key</span><div>
            {s.importPreview ? (
              <div className="b-card">
                <span className="b-dim">This key opens</span>
                <div className="b-idline"><Glyph address={IMPORTED} size={24} theme={theme} /><Hex address={IMPORTED} wrap /></div>
                <div className="b-actions"><button className="b-btn solid">Switch account</button><button className="b-btn" onClick={() => set({ importPreview: false })}>Cancel</button></div>
              </div>
            ) : (
              <div className="b-inline"><input type="password" placeholder="paste private key" aria-label="Private key to import" /><button className="b-btn" onClick={() => set({ importPreview: true })}>Continue</button></div>
            )}
            <p className="b-dim">{COPY.importHelp}</p></div></div>
        </div>
        <div className="b-group danger">
          <h3>Burn</h3>
          <div className="b-kv"><span>Identity</span><div>
            {s.burnConfirm ? (
              <div role="alert" className="b-card danger">
                <p>{COPY.burnConfirm}</p>
                <div className="b-actions"><button className="b-btn destroy">Burn permanently</button><button className="b-btn" onClick={() => set({ burnConfirm: false })}>Cancel</button></div>
              </div>
            ) : (
              <><button className="b-btn danger" onClick={() => set({ burnConfirm: true })}>Burn identity…</button><p className="b-dim">{COPY.burnHelp}</p></>
            )}
          </div></div>
        </div>
        <p className="b-dim b-version">0xChat 0.5.5 · <a href="#">help and docs</a></p>
      </div>
    </section>
  )
}

function ShareB({ s, set, wide }: DirProps) {
  const scan = s.shareTab === 'scan'
  return (
    <div className="b-scrim" onClick={(e) => { if (e.target === e.currentTarget) set({ overlay: null }) }}>
      <div className={`b-dialog ${wide ? '' : 'full'}`} role="dialog" aria-label="Share your address">
        <header className="b-chat-head">
          <div className="b-tabs" role="tablist">
            <button role="tab" aria-selected={!scan} onClick={() => set({ shareTab: 'show' })}>My code</button>
            <button role="tab" aria-selected={scan} onClick={() => set({ shareTab: 'scan' })}>Scan</button>
          </div>
          <span className="b-spacer" />
          <button className="b-icon" aria-label="Close" onClick={() => set({ overlay: null })}><X size={18} /></button>
        </header>
        <div className="b-share">
          {scan ? <div className="b-camera"><span>[ point at a 0xChat code ]</span></div> : (
            <>
              <div className="b-qr"><QR address={SELF} size={200} /></div>
              <Hex address={SELF} wrap />
              <div className="b-actions"><button className="b-btn solid"><Copy size={15} />Copy address</button><button className="b-btn">Copy link</button></div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function AppB(p: DirProps) {
  const { s, wide } = p
  const inChat = !!s.active
  const settingsPage = s.overlay === 'settings'
  return (
    <div className={`b-app ${wide ? 'is-wide' : 'is-narrow'}`}>
      {(wide || !inChat) && <Bar {...p} />}
      {s.trouble && <div className="b-strip warn" role="alert"><span>{COPY.update}</span><button className="b-btn solid">Reload</button></div>}
      {s.trouble && <div className="b-strip" role="status">○ reconnecting…</div>}
      {s.install && <div className="b-strip"><span>Install 0xChat as an app</span><button className="b-btn">Install</button><button className="b-icon" aria-label="Dismiss"><X size={16} /></button></div>}
      <div className="b-main">
        {(wide || (!inChat && !settingsPage)) && <List {...p} />}
        {wide && settingsPage ? <SettingsB {...p} /> : (
          <>
            {(wide || inChat) && (inChat ? <Log {...p} /> : <section className="b-pane b-none"><p className="b-dim">{COPY.tagline}</p></section>)}
            {wide && inChat && <Inspector {...p} />}
          </>
        )}
      </div>
      {!wide && settingsPage && <SettingsB {...p} />}
      {s.overlay === 'share' && <ShareB {...p} />}
      {s.trouble && <div className="b-toast" role="alert">! Couldn’t send. Check your connection and try again.<button className="b-icon" aria-label="Dismiss"><X size={16} /></button></div>}
    </div>
  )
}
