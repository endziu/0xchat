// PROTOTYPE — the comparison board. Four directions for 0xChat's visual
// redesign, switchable with ?variant=a|b|c|d (and ←/→), each shown at desktop
// and phone widths. Not wired to the real app.
import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { ChevronLeft, ChevronRight } from 'lucide-preact'
import { ANON, Clock, MIRA, NEWBIE, TOMASZ, useClockSource, useFrame, type FrameState, type Theme } from './kit'
import { A } from './a'
import { B } from './b'
import { C } from './c'
import { D } from './d'
import './fonts.css'
import './board.css'

const DIRS = [A, B, C, D]
type Dir = typeof A

const PRESETS: Record<string, { label: string; state: FrameState }> = {
  'desk-chat': { label: 'Conversation open', state: { active: MIRA, overlay: null } },
  'desk-settings': { label: 'Settings', state: { active: MIRA, overlay: 'settings' } },
  list: { label: 'Conversations', state: { active: null, overlay: null } },
  chat: { label: 'Chat', state: { active: MIRA, overlay: null } },
  settings: { label: 'Settings', state: { active: null, overlay: 'settings' } },
  first: { label: 'First run, empty list', state: { active: null, overlay: null, emptyList: true, install: true } },
  'new': { label: 'New conversation, not registered', state: { active: null, overlay: null, newConv: true } },
  naming: { label: 'Empty chat, adding a name', state: { active: NEWBIE, overlay: null, renaming: true } },
  trouble: { label: 'When things go wrong', state: { active: ANON, overlay: null, trouble: true, clearConfirm: true, lifetime: '10s' } },
  share: { label: 'Share your address', state: { active: null, overlay: 'share', shareTab: 'show' } },
  'settings-end': { label: 'Settings: import, burn, blocked alerts', state: { active: null, overlay: 'settings', scrollEnd: true, burnConfirm: true, importPreview: true, notifBlocked: true } },
  departed: { label: 'Partner burned their identity', state: { active: TOMASZ, overlay: null, departed: true } },
}

const params = new URLSearchParams(location.search)
const setParam = (key: string, value: string | null) => {
  const next = new URLSearchParams(location.search)
  if (value === null) next.delete(key); else next.set(key, value)
  history.replaceState(null, '', `?${next}`)
}

function StatusBar() {
  return (
    <div className="phone-status" aria-hidden="true">
      <span>9:41</span>
      <span className="phone-icons"><i /><i /><b /></span>
    </div>
  )
}

function Frame({ dir, theme, preset, kind }: { dir: Dir; theme: Theme; preset: string; kind: 'phone' | 'desktop' | 'solo' }) {
  const [s, set] = useFrame(PRESETS[preset].state)
  const [wide, setWide] = useState(kind === 'desktop' || (kind === 'solo' && innerWidth >= 720))
  useEffect(() => {
    if (kind !== 'solo') return
    const onResize = () => setWide(innerWidth >= 720)
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [kind])
  return (
    <div className={`frame ${kind} dir-${dir.key}`} data-theme={theme}>
      <dir.Component s={s} set={set} wide={wide} theme={theme} />
      {kind === 'phone' && <><StatusBar /><div className="phone-home" aria-hidden="true" /></>}
    </div>
  )
}

const TOKENS = ['bg', 'surface', 'raised', 'line', 'text', 'text-2', 'text-3', 'accent', 'accent-text', 'danger']

function Swatches({ dir, theme }: { dir: Dir; theme: Theme }) {
  const [values, setValues] = useState<string[]>([])
  useEffect(() => {
    const probe = document.createElement('div')
    probe.className = `dir-${dir.key}`
    probe.dataset.theme = theme
    document.body.append(probe)
    const cs = getComputedStyle(probe)
    setValues(TOKENS.map(t => cs.getPropertyValue(`--${t}`).trim()))
    probe.remove()
  }, [dir, theme])
  return (
    <ul className="swatches">
      {TOKENS.map((t, i) => (
        <li key={t}><span style={{ background: values[i] }} /><code>--{t}</code><code className="val">{values[i]}</code></li>
      ))}
    </ul>
  )
}

function Slot({ dir, theme, preset, kind }: { dir: Dir; theme: Theme; preset: string; kind: 'phone' | 'desktop' }) {
  return (
    <figure className={`slot ${kind}`}>
      <figcaption>
        <span>{PRESETS[preset].label}</span>
        <a href={`?variant=${dir.key}&theme=${theme}&solo=${preset}`} target="_blank" rel="noopener">Open alone</a>
      </figcaption>
      <Frame key={`${dir.key}-${preset}`} dir={dir} theme={theme} preset={preset} kind={kind} />
    </figure>
  )
}

function Board() {
  const clock = useClockSource()
  const [index, setIndex] = useState(() => Math.max(0, DIRS.findIndex(d => d.key === params.get('variant'))))
  const [theme, setTheme] = useState<Theme>(() => (params.get('theme') as Theme) ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'))
  const dir = DIRS[index]
  const go = (delta: number) => setIndex(i => (i + delta + DIRS.length) % DIRS.length)

  useEffect(() => { setParam('variant', dir.key) }, [dir])
  useEffect(() => { setParam('theme', theme) }, [theme])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable]')) return
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const solo = params.get('solo')
  if (solo && PRESETS[solo]) {
    return <Clock.Provider value={clock}><Frame dir={dir} theme={theme} preset={solo} kind="solo" /></Clock.Provider>
  }

  return (
    <Clock.Provider value={clock}>
      <div className="board">
        <header className="board-head">
          <strong>0xChat redesign <em>prototype, fake data</em></strong>
          <nav className="board-tabs" aria-label="Direction">
            {DIRS.map((d, i) => <button key={d.key} aria-pressed={i === index} onClick={() => setIndex(i)}>{d.title}</button>)}
          </nav>
          <span className="board-spacer" />
          <div className="board-tabs" aria-label="Theme">
            {(['dark', 'light'] as const).map(t => <button key={t} aria-pressed={theme === t} onClick={() => setTheme(t)}>{t === 'dark' ? 'Dark' : 'Light'}</button>)}
          </div>
          <button className="board-btn" onClick={clock.reset} title="Restart every countdown">Restart timers</button>
        </header>

        <section className="board-intro">
          <div>
            <h1>{dir.title}</h1>
            <p>{dir.rationale}</p>
            <p className="type"><b>Type</b> {dir.type}</p>
          </div>
          <Swatches dir={dir} theme={theme} />
        </section>

        <h2 className="board-h">Desktop, 1280 × 800</h2>
        <div className="row desktop-row">
          <Slot dir={dir} theme={theme} preset="desk-chat" kind="desktop" />
          <Slot dir={dir} theme={theme} preset="desk-settings" kind="desktop" />
        </div>

        <h2 className="board-h">Phone, 390 × 844 (installed, with safe areas)</h2>
        <div className="row">
          {['list', 'chat', 'settings'].map(p => <Slot key={p} dir={dir} theme={theme} preset={p} kind="phone" />)}
        </div>

        <h2 className="board-h">Phone states</h2>
        <div className="row">
          {['first', 'new', 'naming', 'trouble', 'share', 'settings-end', 'departed'].map(p => <Slot key={p} dir={dir} theme={theme} preset={p} kind="phone" />)}
        </div>
        <p className="board-foot">Every frame is clickable: open a conversation, go back, open settings or share, start a burn. Timers are live; the 1-minute message burns while you watch.</p>
      </div>

      <div className="switcher" role="toolbar" aria-label="Switch direction">
        <button onClick={() => go(-1)} aria-label="Previous direction"><ChevronLeft size={18} /></button>
        <span><b>{dir.key.toUpperCase()}</b> {dir.name}</span>
        <button onClick={() => go(1)} aria-label="Next direction"><ChevronRight size={18} /></button>
      </div>
    </Clock.Provider>
  )
}

render(<Board />, document.getElementById('board')!)
