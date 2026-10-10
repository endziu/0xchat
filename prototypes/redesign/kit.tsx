// PROTOTYPE — throwaway. Fake data and tiny helpers shared by the four
// directions. Nothing here talks to the real app, crypto, network or storage.
import { createContext } from 'preact'
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { identifierToSvg } from 'glyphid'
import QRCode from 'qrcode'
import { getAddress } from 'viem'

export type Theme = 'dark' | 'light'

const hex = (body: string) => getAddress(`0x${body}`)

export const SELF = hex('7a3f9c21e4b0d58a6e19c3f2b8d047e5a91c6d2f')
export const MIRA = hex('8f3a91c27bd0e44a0c19f2a83b7d51e69a0f4c18')
export const ANON = hex('3b9e0d7c5a21f8e6b4c39d02a7e1f5b8c64d41c7')
export const TOMASZ = hex('c55d2e8a1f907b3c6e4d08a2f1b9c7e3d5a20b96')
export const NEWBIE = hex('9b1f4e7d2c8a06b5e3d9f1a4c7b2e8d05f6a3c91')
export const IMPORTED = hex('5c2e8b7a1d4f90e36c8b2a5d7e1f4c09b6a3d8e2')
export const PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'

export interface Conv { address: string; label?: string; unread?: boolean; stale?: boolean; when: string }

export const CONVS: Conv[] = [
  { address: MIRA, label: 'Mira', unread: true, when: '14:02' },
  { address: ANON, when: 'Yesterday' },
  { address: TOMASZ, label: 'Tomasz (laptop)', when: 'Tue' },
  { address: hex('1e7b4c9a03d6f25e8b1a7c4d9e0f36b2a85c7d14'), label: 'Ola', stale: true, when: 'Sep 28' },
  { address: hex('2f6d9a1c4e8b07f3d2a5c9e16b4f8a0d7c3e15b9'), label: 'Łukasz', when: 'Sep 19' },
  { address: hex('d04a6b2e9c1f73d8a5e0b4c7f2a9d16e3b8ce83b'), when: 'Sep 12' },
]

export interface Msg {
  id: string
  mine: boolean
  text: string
  time: string
  // Day divider placed before this message.
  day?: string
  // Seconds left when the page loaded.
  left: number
  // The lifetime it was opened with; null while the partner hasn't opened it.
  total: number | null
}

export const CHATS: Record<string, Msg[]> = {
  [MIRA]: [
    { id: 'm1', mine: false, day: 'Yesterday', time: '21:40', text: 'did you get home ok?', left: 7080, total: 21600 },
    { id: 'm2', mine: true, time: '21:52', text: 'yep. train was late again, but I had a book', left: 12600, total: 21600 },
    { id: 'm3', mine: false, day: 'Today', time: '13:55', text: 'ok so the address for saturday:\nMokotowska 12/4, buzzer 41\nthird floor, the door sticks, push hard\n\nbring nothing, we have way too much food', left: 1452, total: 1800 },
    { id: 'm4', mine: true, time: '13:57', text: 'perfect. what time?', left: 1673, total: 1800 },
    { id: 'm5', mine: false, time: '13:58', text: '7ish? people will drift in', left: 1700, total: 1800 },
    { id: 'm6', mine: false, time: '13:58', text: 'also bring the speaker if you still have it', left: 1712, total: 1800 },
    { id: 'm7', mine: true, time: '14:01', text: 'https://maps.example.org/?q=Mokotowska+12', left: 238, total: 300 },
    { id: 'm8', mine: false, time: '14:02', text: 'wifi when you get here: dom-mokotowska / plum-otter-9-lantern\nthis one burns in a minute', left: 47, total: 60 },
    { id: 'm9', mine: true, time: '14:02', text: 'got it, thanks', left: 86340, total: null },
  ],
  [ANON]: [
    { id: 'a1', mine: false, day: 'Yesterday', time: '18:20', text: 'hey, it’s Kasia from the meetup. this is my throwaway address', left: 3400, total: 21600 },
    { id: 'a2', mine: true, time: '18:31', text: 'hi! saved you. what was the name of the talk you mentioned?', left: 5100, total: 21600 },
  ],
  [TOMASZ]: [
    { id: 't1', mine: false, day: 'Tue', time: '09:12', text: 'moving everything to the new key, this one goes away today', left: 2000, total: 86400 },
  ],
}

export const LIFETIMES = ['5s', '10s', '30s', '1m', '5m', '30m', '1h', '6h', '24h']
export const LIFETIME_WORDS: Record<string, string> = {
  '5s': '5 seconds', '10s': '10 seconds', '30s': '30 seconds', '1m': '1 minute', '5m': '5 minutes',
  '30m': '30 minutes', '1h': '1 hour', '6h': '6 hours', '24h': '24 hours',
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
// "0x" plus ten groups of four: the full address, but readable.
export const chunks = (a: string) => [a.slice(0, 2), ...a.slice(2).match(/.{4}/g)!]
export const nameOf = (c: Conv) => c.label ?? short(c.address)
export const convOf = (address: string): Conv => CONVS.find(c => c.address === address) ?? { address, when: '' }

export function fmtLeft(s: number) {
  if (s < 60) return `${Math.max(0, Math.ceil(s))}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

// --- the clock: every frame shares one, so countdowns tick together --------
export const Clock = createContext({ elapsed: 0 })
export function useClockSource() {
  const [t0, setT0] = useState(() => Date.now())
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setElapsed((Date.now() - t0) / 1000), 1000)
    return () => clearInterval(id)
  }, [t0])
  return { elapsed, reset: () => { setT0(Date.now()); setElapsed(0) } }
}

export interface Live extends Msg { remaining: number; leaving: boolean }
// Messages with their live remaining time. A message lingers 1.2s after
// reaching zero so each direction can show it going.
export function useLive(list: Msg[]): Live[] {
  const { elapsed } = useContext(Clock)
  return list
    .map(m => ({ ...m, remaining: m.left - elapsed, leaving: m.left - elapsed <= 0 }))
    .filter(m => m.remaining > -1.2)
}

// --- avatars & QR -----------------------------------------------------------
export function Glyph({ address, size = 24, theme, className = '' }: { address: string; size?: number; theme: Theme; className?: string }) {
  const __html = useMemo(() => identifierToSvg(address.toLowerCase(), { variant: 'mosaic', theme, size, decorative: true }), [address, size, theme])
  return <span className={`glyph ${className}`} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html }} />
}

export function QR({ address, size = 180 }: { address: string; size?: number }) {
  const [svg, setSvg] = useState('')
  useEffect(() => {
    QRCode.toString(`https://chat.endziu.xyz/chat/${address}`, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } })
      .then(setSvg).catch(() => {})
  }, [address])
  return <span className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />
}

// --- per-frame state --------------------------------------------------------
export interface FrameState {
  active: string | null
  overlay: null | 'settings' | 'share' | 'info'
  shareTab?: 'show' | 'scan'
  emptyList?: boolean
  install?: boolean
  newConv?: boolean
  renaming?: boolean
  trouble?: boolean
  clearConfirm?: boolean
  burnConfirm?: boolean
  importPreview?: boolean
  notifBlocked?: boolean
  departed?: boolean
  scrollEnd?: boolean
  lifetime?: string
}
export type SetFrame = (patch: Partial<FrameState>) => void
export interface DirProps { s: FrameState; set: SetFrame; wide: boolean; theme: Theme }

export function useFrame(initial: FrameState): [FrameState, SetFrame] {
  const [s, setS] = useState(initial)
  return [s, (patch) => setS(prev => ({ ...prev, ...patch }))]
}

// Messages for the open conversation, honouring the frame's flags.
export function chatFor(s: FrameState): Msg[] {
  if (!s.active || s.active === NEWBIE) return []
  return CHATS[s.active] ?? []
}

// Keeps a transcript on its newest message, like the real pane does.
export function useStickBottom(count: number) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight }, [count])
  return ref
}

// Scroll a settings panel to its end once, for the "end of settings" preset.
const scrolledToEnd = new WeakSet<HTMLElement>()
export function scrollEndRef(on?: boolean) {
  return (el: HTMLElement | null) => {
    if (!el || !on || scrolledToEnd.has(el)) return
    scrolledToEnd.add(el)
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  }
}

// Same words in every direction, so the comparison is about form.
export const COPY = {
  tagline: 'End-to-end encrypted. Messages disappear after they’re opened.',
  emptyListTitle: 'No conversations yet',
  emptyListBody: 'Share your address or QR code. When someone writes to you, they’ll show up here.',
  emptyChatTitle: 'No messages yet',
  emptyChatBody: 'Only the two of you can read what’s sent here. Each message disappears after it’s opened, once its lifetime runs out.',
  notOpened: 'not opened',
  unreachableNote: 'Address not registered yet. Check it, or ask them to open 0xChat once.',
  couldNotOpen: 'Some messages could not be opened',
  couldNotOpenDetail: 'They stay hidden until the server confirms opening.',
  update: '0xChat has been updated. Reload to keep chatting.',
  olderError: 'Couldn’t load older messages.',
  departed: (n: string) => `${n} deleted their identity. Messages can’t be delivered.`,
  lifetimeHelp: 'How long your messages last after they’re opened. Unopened messages are deleted after 24 hours.',
  notifHelp: 'Alerts never include message text or who sent it.',
  notifBlocked: 'Blocked in this browser. Allow notifications in this site’s settings, then reload.',
  keyHelp: 'Your private key is your account. Keep a copy somewhere safe and never share it. If every copy is lost, so is this account.',
  importHelp: 'Switch this browser to an account you already have.',
  burnHelp: 'Deletes this account, its key and every message, for good.',
  burnConfirm: 'Burn this identity? Your account, key and all messages are deleted. This can’t be undone.',
}
