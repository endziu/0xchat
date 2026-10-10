// PROTOTYPE — Direction C, "Index": Swiss/editorial. One grotesk, a strict
// left edge, big names, whitespace instead of boxes. Ink does the work; the one
// colour, ember, is kept for things that burn or break.
import { useState } from 'preact/hooks'
import { ArrowLeft, ArrowUp, Camera, Check, CircleHelp, QrCode, Settings, X } from 'lucide-preact'
import {
  CONVS, COPY, IMPORTED, LIFETIMES, LIFETIME_WORDS, NEWBIE, PRIVATE_KEY, SELF, chatFor, chunks, convOf, fmtLeft, nameOf, scrollEndRef, short, useLive, useStickBottom,
  Glyph, QR, type DirProps,
} from './kit'
import './c.css'

export const C = {
  key: 'c',
  name: 'Index',
  title: 'C. Index',
  rationale: 'Swiss and editorial. Hierarchy comes from size and weight, not from boxes. Names are set large, everything hangs off one strict left edge, and whitespace does the separating. There are no bubbles: your own messages are indented on the grid, as in a printed dialogue. Ink is black on white, white on black. The one colour, ember, appears only on things that burn or break: countdowns, short lifetimes, errors and Burn. Addresses are set as type, large and grouped, so a QR code is not the only way to read them.',
  type: 'Schibsted Grotesk (variable, 400–800), self-hosted, about 70 KB with Polish characters. One family; tabular figures for hex and times.',
  Component: AppC,
}

function Addr({ address, big }: { address: string; big?: boolean }) {
  return <span className={`c-addr ${big ? 'big' : ''}`} aria-label={address}>{chunks(address).map((c, i) => <span key={i}>{c}</span>)}</span>
}

function Masthead({ s, set, wide, theme }: DirProps) {
  return (
    <header className="c-mast">
      <button className="c-word" onClick={() => set({ active: null, overlay: null })}>0xChat</button>
      <span className={`c-live ${s.trouble ? 'off' : ''}`} title={s.trouble ? 'Reconnecting' : 'Live'} />
      <span className="c-spacer" />
      {wide && <span className="c-self"><Glyph address={SELF} size={18} theme={theme} />{short(SELF)}</span>}
      <button className="c-icon" aria-label="Share your address" onClick={() => set({ overlay: 'share', shareTab: 'show' })}><QrCode size={19} /></button>
      <button className="c-icon" aria-label="Settings" onClick={() => set({ overlay: s.overlay === 'settings' ? null : 'settings' })}><Settings size={19} /></button>
      <a className="c-icon" href="#" aria-label="Help"><CircleHelp size={19} /></a>
    </header>
  )
}

function Index({ s, set, theme }: DirProps) {
  const [confirm, setConfirm] = useState<string | null>(null)
  return (
    <nav className="c-index">
      <div className="c-titlerow">
        <h1>Conversations</h1>
        {!s.emptyList && <button className="c-text" onClick={() => set({ newConv: !s.newConv })}>{s.newConv ? 'Cancel' : 'New'}</button>}
      </div>
      {s.newConv && (
        <div className="c-form">
          <label><span>Address</span><input className="tnum" defaultValue={NEWBIE} spellcheck={false} /></label>
          <label><span>Name <em>optional</em></span><input placeholder="What you call them" /></label>
          <p className="c-err" role="alert">{COPY.unreachableNote}</p>
          <div className="c-actions">
            <button className="c-btn solid">Start conversation</button>
            <button className="c-btn" onClick={() => set({ overlay: 'share', shareTab: 'scan' })}><Camera size={17} />Scan</button>
          </div>
        </div>
      )}
      {s.emptyList ? (
        <div className="c-empty">
          <p className="c-lede">{COPY.emptyListTitle}.</p>
          <p>{COPY.emptyListBody}</p>
          <Addr address={SELF} big />
          <div className="c-actions">
            <button className="c-btn solid" onClick={() => set({ overlay: 'share', shareTab: 'show' })}>Share your address</button>
            <button className="c-btn" onClick={() => set({ newConv: true })}>Start a conversation</button>
          </div>
        </div>
      ) : (
        <ol className="c-rows">
          {CONVS.map(c => (
            <li key={c.address} className={`${s.active === c.address ? 'active' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => set({ active: c.address, newConv: false, overlay: null })}>
              <Glyph address={c.address} size={28} theme={theme} />
              <span className="c-name">{c.label ?? <span className="tnum">{short(c.address)}</span>}</span>
              <time className="tnum">{c.when}</time>
              <span className="c-meta">{c.unread ? 'Unread' : c.stale ? 'No messages' : c.label ? short(c.address) : 'No name'}</span>
              <button className={`c-rm ${confirm === c.address ? 'confirm' : ''}`} onClick={(e) => { e.stopPropagation(); setConfirm(confirm === c.address ? null : c.address) }} aria-label="Remove conversation">
                {confirm === c.address ? 'Remove and forget?' : <X size={16} />}
              </button>
            </li>
          ))}
        </ol>
      )}
    </nav>
  )
}

function Dialogue({ s, set, wide, theme }: DirProps) {
  const conv = convOf(s.active!)
  const msgs = useLive(chatFor(s))
  const ref = useStickBottom(msgs.length)
  const name = nameOf(conv)
  return (
    <section className="c-pane">
      <header className="c-head">
        {!wide && <button className="c-icon back" aria-label="Back" onClick={() => set({ active: null })}><ArrowLeft size={22} /></button>}
        {s.renaming ? (
          <form className="c-rename" onSubmit={(e) => { e.preventDefault(); set({ renaming: false }) }}>
            <input defaultValue="Kasia" aria-label="Name" />
            <button className="c-icon" aria-label="Save"><Check size={20} /></button>
            <button type="button" className="c-icon" aria-label="Cancel" onClick={() => set({ renaming: false })}><X size={20} /></button>
          </form>
        ) : (
          <button className="c-headline" onClick={() => set({ renaming: true })} title={conv.label ? 'Rename' : 'Add a name'}>
            <span className={conv.label ? '' : 'tnum'}>{conv.label ?? short(conv.address)}</span>
          </button>
        )}
        <div className="c-subline">
          <Glyph address={conv.address} size={18} theme={theme} />
          {wide ? <Addr address={conv.address} /> : <span className="tnum">{short(conv.address)}</span>}
          <span className="c-spacer" />
          {!conv.label && !s.renaming && <button className="c-text" onClick={() => set({ renaming: true })}>Add a name</button>}
          <button className="c-text">Copy address</button>
          <button className={`c-text ${s.clearConfirm ? 'ember' : ''}`} onClick={() => set({ clearConfirm: !s.clearConfirm })}>{s.clearConfirm ? 'Clear for both of you?' : 'Clear'}</button>
        </div>
      </header>
      {s.trouble && (
        <div className="c-notice" role="alert">
          <b>{COPY.couldNotOpen}.</b> {COPY.couldNotOpenDetail} <button className="c-text">Retry</button>
        </div>
      )}
      <div className="c-log" role="log" ref={ref}>
        <div className="c-grow" />
        {msgs.length === 0 ? (
          <div className="c-empty">
            <p className="c-lede">{COPY.emptyChatTitle}.</p>
            <p>{COPY.emptyChatBody}</p>
          </div>
        ) : (
          <div className="c-older">
            {s.trouble && <span className="c-err">{COPY.olderError}</span>}
            <button className="c-text">{s.trouble ? 'Retry' : 'Load older messages'}</button>
          </div>
        )}
        {msgs.map((m, i) => {
          const prev = msgs[i - 1]
          const start = !prev || prev.mine !== m.mine || !!m.day
          return (
            <div key={m.id} className="c-item">
              {m.day && <h2 className="c-day">{m.day}</h2>}
              <article className={`c-msg ${m.mine ? 'mine' : ''} ${start ? 'start' : ''} ${m.leaving ? 'leaving' : ''}`}>
                <div className="c-margin tnum">
                  {start && <time>{m.time}</time>}
                  <span className={m.total ? (m.remaining <= 60 ? 'burn soon' : 'burn') : 'sealed'}>{m.total ? fmtLeft(m.remaining) : 'unopened'}</span>
                </div>
                <div className="c-copy">
                  {start && <span className="c-speaker">{m.mine ? 'You' : name}</span>}
                  <p>{m.text.split(/(https?:\/\/\S+)/).map((p, k) => k % 2 ? <a key={k} href="#">{p}</a> : p)}</p>
                </div>
              </article>
            </div>
          )
        })}
      </div>
      {s.departed ? <p className="c-departed" role="status">{COPY.departed(name)}</p> : <ComposerC s={s} set={set} name={name} />}
    </section>
  )
}

function ComposerC({ s, set, name }: Pick<DirProps, 's' | 'set'> & { name: string }) {
  const [draft, setDraft] = useState('')
  const lifetime = s.lifetime ?? '30m'
  const short = ['5s', '10s', '30s', '1m'].includes(lifetime)
  return (
    <form className="c-composer" onSubmit={(e) => { e.preventDefault(); setDraft('') }}>
      <textarea rows={1} placeholder={`Write to ${name}`} value={draft} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} aria-label={`Message ${name}`} />
      <div className="c-compose-row">
        <label className={`c-life ${short ? 'short' : ''}`}>
          Burns {LIFETIME_WORDS[lifetime]} after opening
          <select value={lifetime} onChange={(e) => set({ lifetime: (e.target as HTMLSelectElement).value })} aria-label="Message lifetime">
            {LIFETIMES.map(l => <option key={l} value={l}>{LIFETIME_WORDS[l]}</option>)}
          </select>
        </label>
        <button className="c-send" disabled={!draft.trim()} aria-label="Send"><ArrowUp size={20} /></button>
      </div>
    </form>
  )
}

function SettingsC({ s, set, wide, theme }: DirProps) {
  const [showKey, setShowKey] = useState(false)
  const [notify, setNotify] = useState(true)
  const lifetime = s.lifetime ?? '30m'
  return (
    <section className={`c-settings ${wide ? 'page' : 'sheet'}`} aria-label="Settings">
      <div className="c-scroll" ref={scrollEndRef(s.scrollEnd)}>
        <div className="c-titlerow">
          <h1>Settings</h1>
          <button className="c-icon" aria-label="Close settings" onClick={() => set({ overlay: null })}><X size={22} /></button>
        </div>
        <section className="c-sec">
          <h2>Your address</h2>
          <div>
            <div className="c-idline"><Glyph address={SELF} size={40} theme={theme} /><Addr address={SELF} big /></div>
            <div className="c-actions"><button className="c-btn">Copy address</button><button className="c-btn">Copy link</button><button className="c-btn" onClick={() => set({ overlay: 'share', shareTab: 'show' })}>QR code</button></div>
          </div>
        </section>
        <section className="c-sec">
          <h2>Messages</h2>
          <div>
            <label className="c-field"><span>Default lifetime</span>
              <select value={lifetime} onChange={(e) => set({ lifetime: (e.target as HTMLSelectElement).value })}>
                <option value="remember">Remember last</option>
                {LIFETIMES.map(l => <option key={l} value={l}>{LIFETIME_WORDS[l]}</option>)}
              </select>
            </label>
            <p className="c-note">{COPY.lifetimeHelp}</p>
          </div>
        </section>
        <section className="c-sec">
          <h2>Alerts</h2>
          <div>
            <div className="c-field"><span id="c-notif">New message alerts</span>
              {!s.notifBlocked && <button role="switch" aria-checked={notify} aria-labelledby="c-notif" className="c-switch" onClick={() => setNotify(!notify)}><i /><b>{notify ? 'On' : 'Off'}</b></button>}
            </div>
            <p className={s.notifBlocked ? 'c-err' : 'c-note'}>{s.notifBlocked ? COPY.notifBlocked : COPY.notifHelp}</p>
          </div>
        </section>
        <section className="c-sec">
          <h2>Your key</h2>
          <div>
            <p className="c-note strong">{COPY.keyHelp}</p>
            <p className="c-key tnum">{showKey ? PRIVATE_KEY : '0x' + '•'.repeat(28)}</p>
            <div className="c-actions"><button className="c-btn" onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide key' : 'Show key'}</button><button className="c-btn">Copy key</button></div>
            <h3>Use another key</h3>
            <p className="c-note">{COPY.importHelp}</p>
            {s.importPreview ? (
              <div className="c-preview">
                <span className="c-note">This key opens</span>
                <div className="c-idline"><Glyph address={IMPORTED} size={28} theme={theme} /><Addr address={IMPORTED} /></div>
                <div className="c-actions"><button className="c-btn solid">Switch to this account</button><button className="c-text" onClick={() => set({ importPreview: false })}>Cancel</button></div>
              </div>
            ) : (
              <div className="c-inline"><input type="password" placeholder="Paste a private key" aria-label="Private key to import" /><button className="c-btn" onClick={() => set({ importPreview: true })}>Continue</button></div>
            )}
          </div>
        </section>
        <section className="c-sec burn">
          <h2>Burn identity</h2>
          <div>
            {s.burnConfirm ? (
              <div role="alert">
                <p className="c-note strong">{COPY.burnConfirm}</p>
                <div className="c-actions"><button className="c-btn burn">Burn permanently</button><button className="c-text" onClick={() => set({ burnConfirm: false })}>Cancel</button></div>
              </div>
            ) : (
              <>
                <p className="c-note">{COPY.burnHelp}</p>
                <div className="c-actions"><button className="c-btn ember" onClick={() => set({ burnConfirm: true })}>Burn identity…</button></div>
              </>
            )}
          </div>
        </section>
        <p className="c-colophon tnum">0xChat 0.5.5. <a href="#">Help and docs</a></p>
      </div>
    </section>
  )
}

function ShareC({ s, set, wide }: DirProps) {
  const scan = s.shareTab === 'scan'
  return (
    <div className="c-scrim" onClick={(e) => { if (e.target === e.currentTarget) set({ overlay: null }) }}>
      <div className={`c-dialog ${wide ? '' : 'full'}`} role="dialog" aria-label="Share your address">
        <div className="c-titlerow">
          <h1>{scan ? 'Scan a code' : 'Your address'}</h1>
          <button className="c-icon" aria-label="Close" onClick={() => set({ overlay: null })}><X size={22} /></button>
        </div>
        {scan ? <div className="c-camera">Point the camera at a 0xChat QR code.</div> : (
          <>
            <div className="c-qr"><QR address={SELF} size={wide ? 220 : 240} /></div>
            <Addr address={SELF} big />
            <div className="c-actions"><button className="c-btn solid">Copy address</button><button className="c-btn">Copy link</button></div>
          </>
        )}
        <button className="c-text" onClick={() => set({ shareTab: scan ? 'show' : 'scan' })}>{scan ? 'Show my code instead' : 'Scan someone else’s code'}</button>
      </div>
    </div>
  )
}

function AppC(p: DirProps) {
  const { s, wide } = p
  const inChat = !!s.active
  const settings = s.overlay === 'settings'
  return (
    <div className={`c-app ${wide ? 'is-wide' : 'is-narrow'}`}>
      {s.trouble && <div className="c-update" role="alert"><span>{COPY.update}</span><button className="c-btn inverse">Reload</button></div>}
      {(wide || !inChat) && <Masthead {...p} />}
      {s.trouble && <div className="c-reconnect" role="status">Reconnecting…</div>}
      {s.install && <div className="c-install"><span>Install 0xChat as an app.</span><button className="c-text">Install</button><button className="c-icon" aria-label="Dismiss"><X size={18} /></button></div>}
      <div className="c-main">
        {(wide || (!inChat && !settings)) && <Index {...p} />}
        {wide && settings ? <SettingsC {...p} /> : (wide || inChat) && (inChat ? <Dialogue {...p} /> : <section className="c-pane c-none"><p className="c-lede">{COPY.tagline}</p></section>)}
      </div>
      {!wide && settings && <SettingsC {...p} />}
      {s.overlay === 'share' && <ShareC {...p} />}
      {s.trouble && <div className="c-toast" role="alert"><b>Couldn’t send.</b> Check your connection and try again.<button className="c-icon" aria-label="Dismiss"><X size={18} /></button></div>}
    </div>
  )
}
