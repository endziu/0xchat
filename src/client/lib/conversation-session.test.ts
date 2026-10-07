import { requireAddress } from '../../shared/address'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { ConversationSession, type ConversationProtocol, type SessionClock } from './conversation-session'
import type { DecryptedMessage } from './conversation-messages'
import type { ConfirmationResponse, MessagePage, RecoveryPage } from '../../shared/protocol-client'
import { isEnvelopeParticipant, UNOPENED_RETENTION_MS, type DeliveredMessage } from '../../shared/message-envelope'

// The session runs against an in-memory server and a manual clock: every
// response resolves through promises alone, so `settle()` completes all
// pending work deterministically.
const SELF = requireAddress('0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2')
const PARTNER = requireAddress('0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1')

// Failed requests are logged as they would be in the browser.
beforeEach(() => { spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { spyOn(console, 'error').mockRestore(); spyOn(Date, 'now').mockRestore() })

/** Lets every pending response and continuation run. */
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

class ManualClock implements SessionClock {
  time = 1_000_000
  timers: Array<{ at: number; delay: number; callback: () => void }> = []

  now(): number {
    return this.time
  }

  setTimer(callback: () => void, delay: number): () => void {
    const timer = { at: this.time + delay, delay, callback }
    this.timers.push(timer)
    return () => { this.timers = this.timers.filter(other => other !== timer) }
  }

  /** Moves time forward, firing the timers that come due on the way. */
  advance(ms: number): void {
    const until = this.time + ms
    for (;;) {
      const due = this.timers.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter(timer => timer !== due)
      this.time = Math.max(this.time, due.at)
      due.callback()
    }
    this.time = until
  }
}

type Operation = 'pubkey' | 'history' | 'recover' | 'states' | 'open' | 'clear' | 'conversations' | 'send'

let nextId = 0

/**
 * One conversation as the server stores it. Each response is computed when
 * the request arrives; a held operation delays only its delivery, as a slow
 * network does.
 */
class FakeServer implements ConversationProtocol {
  readonly log: string[] = []
  readonly stored: DecryptedMessage[] = []
  private clearedAt = -Infinity
  private readonly gates = new Map<Operation, Promise<void>>()
  private readonly failures = new Map<Operation, number>()

  constructor(private readonly clock: ManualClock) {}

  /** A message accepted now, from the partner unless `from` is SELF. */
  accept(plaintext: string, { from = PARTNER, ttl = 300 } = {}): DecryptedMessage {
    const createdAt = this.clock.now()
    const message: DecryptedMessage = {
      version: 2, id: `m${++nextId}`, sender: from, recipient: from === PARTNER ? SELF : PARTNER, ttl,
      ct_recipient: '', ephemeral_pub_recipient: '', iv_recipient: '',
      ct_sender: '', ephemeral_pub_sender: '', iv_sender: '', signature: '',
      plaintext, delivery_policy: 'recipient-opening',
      created_at: createdAt, opened_at: null, expires_at: createdAt + UNOPENED_RETENTION_MS,
    }
    this.stored.push(message)
    return message
  }

  /** Delays the response to the next `operation` request until release. */
  hold(operation: Operation): { release(): void } {
    let release!: () => void
    this.gates.set(operation, new Promise<void>(resolve => { release = resolve }))
    return { release }
  }

  fail(operation: Operation, times = 1): void {
    this.failures.set(operation, times)
  }

  partnerPubkey(): Promise<string | null> {
    return this.respond('pubkey', 'pubkey', () => '0xpubkey')
  }

  history(limit: number, before?: number): Promise<MessagePage> {
    return this.respond('history', before ? `history before=${before}` : 'history', () => {
      const page = this.available().filter(({ seq }) => !before || seq < before).reverse().slice(0, limit)
      return {
        recovery_cursor: String(this.stored.length),
        messages: page.map(({ message }) => ({ ...message })),
        next_before_seq: page.at(-1)?.seq ?? null,
      }
    })
  }

  recover(cursor: { after: string } | { cursor: string }): Promise<RecoveryPage> {
    const after = Number('after' in cursor ? cursor.after : cursor.cursor)
    return this.respond('recover', 'after' in cursor ? `recover after=${after}` : `recover cursor=${after}`, () => {
      const missed = this.available().filter(({ seq }) => seq > after)
      const page = missed.slice(0, 100)
      const exhausted = page.length === missed.length
      return {
        messages: page.map(({ message }) => ({ ...message })),
        exhausted,
        next_cursor: exhausted ? null : String(page.at(-1)!.seq),
        recovery_cursor: exhausted ? String(this.stored.length) : null,
      }
    })
  }

  states(ids: string[]): Promise<ConfirmationResponse | null> {
    return this.respond('states', `states ${ids.join(',')}`, () => this.results(ids))
  }

  open(ids: string[]): Promise<ConfirmationResponse | null> {
    return this.respond('open', `open ${ids.join(',')}`, () => {
      for (const { message } of this.available()) {
        if (ids.includes(message.id) && message.recipient === SELF) this.openStored(message.id)
      }
      return this.results(ids)
    })
  }

  clear(): Promise<{ cleared_at: number }> {
    return this.respond('clear', 'clear', () => {
      this.clearedAt = this.clock.now()
      return { cleared_at: this.clearedAt }
    })
  }

  refreshConversations(): Promise<boolean> {
    return this.respond('conversations', 'conversations', () => true)
  }

  send(plaintext: string, ttl: number): Promise<DeliveredMessage> {
    return this.respond('send', 'send', () => this.accept(plaintext, { from: SELF, ttl }))
  }

  /** Opens a message the way the recipient's other device would; returns its expiry update. */
  openStored(id: string): DecryptedMessage {
    const index = this.stored.findIndex(message => message.id === id)
    const message = this.stored[index]!
    if (message.opened_at !== null) return message
    const now = this.clock.now()
    const opened = { ...message, opened_at: now, expires_at: now + message.ttl * 1000 }
    this.stored[index] = opened
    return opened
  }

  private available(): Array<{ message: DecryptedMessage; seq: number }> {
    const now = this.clock.now()
    return this.stored.map((message, index) => ({ message, seq: index + 1 }))
      .filter(({ message }) => message.created_at > this.clearedAt && message.expires_at > now)
  }

  private results(ids: string[]): ConfirmationResponse {
    const available = new Map(this.available().map(({ message }) => [message.id, message]))
    return {
      server_time: this.clock.now(),
      results: ids.map(id => {
        const message = available.get(id)
        if (!message) return { id, status: 'unavailable' }
        const { delivery_policy, created_at, opened_at, expires_at } = message
        return { id, status: 'available', delivery_policy, created_at, opened_at, expires_at }
      }),
    }
  }

  private respond<T>(operation: Operation, entry: string, result: () => T): Promise<T> {
    this.log.push(entry)
    const failures = this.failures.get(operation) ?? 0
    if (failures > 0) this.failures.set(operation, failures - 1)
    const value = failures > 0 ? null : result()
    const gate = this.gates.get(operation)
    this.gates.delete(operation)
    return (async () => {
      await gate
      if (failures > 0) throw new Error(`${operation} failed`)
      return value as T
    })()
  }
}

/** Requests that touch messages, without the incidental key and list lookups. */
const messageRequests = (server: FakeServer) => server.log.filter(entry => !['pubkey', 'conversations'].includes(entry))

function setup({ attentive = true, connected = true } = {}) {
  const clock = new ManualClock()
  const server = new FakeServer(clock)
  const decrypted: string[] = []
  let decryption: Promise<void> | null = null
  const create = (protocol: ConversationProtocol = server) => new ConversationSession({
    self: SELF,
    partner: PARTNER,
    protocol,
    // Verification and decryption are the port's job; here every envelope is
    // already plaintext, and other conversations' messages are dropped.
    decrypt: async input => {
      const message = input as DecryptedMessage
      decrypted.push(message.id)
      await decryption
      return isEnvelopeParticipant(message, SELF, PARTNER) ? message : null
    },
    clock,
    connection: connected ? Symbol('stream') : null,
    attentive,
  })
  /** Delays every decryption that starts before release. */
  const holdDecryption = () => {
    let release!: () => void
    decryption = new Promise<void>(resolve => { release = resolve })
    return { release: () => { decryption = null; release() } }
  }
  return { clock, server, create, decrypted, holdDecryption }
}

const shown = (session: ConversationSession) => session.snapshot().messages.map(message => message.plaintext)

test('an incoming message shows only once the server confirms its opening', async () => {
  const { server, create } = setup()
  const sent = server.accept('first secret')
  const opening = server.hold('open')
  const session = create()
  await settle()
  expect(server.log).toContain(`open ${sent.id}`)
  expect(shown(session)).toEqual([])

  opening.release()
  await settle()
  expect(shown(session)).toEqual(['first secret'])
})

const live = (message: DeliveredMessage) => ({ type: 'message' as const, data: message })

test('nothing opens until the conversation is attentive and synchronized on the current connection', async () => {
  const { server, create } = setup({ attentive: false, connected: false })
  const sent = server.accept('unattended secret')
  const session = create()
  session.connectionChanged(Symbol('stream'))
  await settle()
  expect(messageRequests(server)).toEqual([])

  session.connectionChanged(null)
  session.attentionChanged(true)
  await settle()
  expect(messageRequests(server)).toEqual([])
  expect(shown(session)).toEqual([])

  session.connectionChanged(Symbol('stream'))
  await settle()
  expect(messageRequests(server)).toEqual(['history', `states ${sent.id}`, `open ${sent.id}`])
  expect(shown(session)).toEqual(['unattended secret'])
})

test('messages arriving while an opening is in flight share the next request', async () => {
  const { server, create } = setup()
  const first = server.accept('first of a burst')
  const opening = server.hold('open')
  const session = create()
  await settle()
  const followers = ['one', 'two', 'three'].map(text => server.accept(`follower ${text}`))
  for (const follower of followers) session.liveEvent(live(follower))
  await settle()
  expect(server.log.filter(entry => entry.startsWith('open'))).toEqual([`open ${first.id}`])

  opening.release()
  await settle()
  expect(server.log.filter(entry => entry.startsWith('open'))).toEqual([`open ${first.id}`, `open ${followers.map(message => message.id).join(',')}`])
  expect(shown(session)).toEqual(['first of a burst', 'follower one', 'follower two', 'follower three'])
})

const openings = (server: FakeServer) => server.log.filter(entry => entry.startsWith('open'))

test('an opening confirmed after attention is lost stays hidden until attention returns and opening is confirmed again', async () => {
  const { server, create } = setup()
  const sent = server.accept('confirmed while away')
  const opening = server.hold('open')
  const session = create()
  await settle()
  session.attentionChanged(false)
  opening.release()
  await settle()
  expect(shown(session)).toEqual([])

  session.attentionChanged(true)
  await settle()
  expect(openings(server)).toEqual([`open ${sent.id}`, `open ${sent.id}`])
  expect(shown(session)).toEqual(['confirmed while away'])
})

test('new work re-requests opening without waiting behind a superseded request', async () => {
  const { server, create } = setup()
  const sent = server.accept('interrupted opening')
  const opening = server.hold('open')
  const session = create()
  await settle()
  session.attentionChanged(false)
  session.attentionChanged(true)
  await settle()
  expect(openings(server)).toEqual([`open ${sent.id}`, `open ${sent.id}`])
  expect(shown(session)).toEqual(['interrupted opening'])

  opening.release()
  await settle()
  expect(shown(session)).toEqual(['interrupted opening'])
})

test('only the current request settles an opening, even when superseded work requested the same messages', async () => {
  const { server, create } = setup()
  server.accept('requested twice')
  const stale = server.hold('open')
  const session = create()
  await settle()
  server.fail('open')
  const current = server.hold('open')
  session.attentionChanged(false)
  session.attentionChanged(true)
  await settle()
  stale.release()
  await settle()
  current.release()
  await settle()
  expect(session.snapshot()).toMatchObject({ messages: [], openingFailed: true })

  session.retryOpening()
  await settle()
  expect(shown(session)).toEqual(['requested twice'])
})

test.each([
  ['the connection', (session: ConversationSession) => session.connectionChanged(null), (session: ConversationSession) => session.connectionChanged(Symbol('stream'))],
  ['attention', (session: ConversationSession) => session.attentionChanged(false), (session: ConversationSession) => session.attentionChanged(true)],
])('a history page that arrives after %s is lost is ignored', async (_lost, lose, regain) => {
  const { server, create } = setup()
  const sent = server.accept('loaded while away')
  const history = server.hold('history')
  const session = create()
  await settle()
  lose(session)
  history.release()
  await settle()
  expect(messageRequests(server)).toEqual(['history'])
  expect(shown(session)).toEqual([])

  regain(session)
  await settle()
  expect(messageRequests(server)).toEqual(['history', 'history', `states ${sent.id}`, `open ${sent.id}`])
  expect(shown(session)).toEqual(['loaded while away'])
})

test('a disposed session ignores late responses and live events, and opens nothing more', async () => {
  const { server, create } = setup()
  server.accept('previous conversation')
  const history = server.hold('history')
  const session = create()
  await settle()
  let published = 0
  session.subscribe(() => published++)
  const before = session.snapshot()
  session.dispose()
  history.release()
  session.liveEvent(live(server.accept('after leaving')))
  session.connectionChanged(Symbol('stream'))
  session.attentionChanged(false)
  await settle()
  expect(published).toBe(0)
  expect(session.snapshot()).toBe(before)
  expect(messageRequests(server)).toEqual(['history'])
})

test('a session for another conversation starts empty', async () => {
  const { server, create } = setup()
  server.accept('previous conversation')
  const previous = create()
  await settle()
  expect(shown(previous)).toEqual(['previous conversation'])
  previous.dispose()

  const other = new FakeServer(new ManualClock())
  const next = create(other)
  expect(shown(next)).toEqual([])
  expect(next.snapshot()).toMatchObject({ loading: true, recovering: true, hasMore: false, recipientPubkey: null })
})

test('a reconnect recovers from the baseline the initial page set', async () => {
  const { server, create } = setup()
  server.accept('baseline')
  const session = create()
  await settle()
  session.connectionChanged(null)
  const missed = server.accept('missed while down')
  session.connectionChanged(Symbol('stream'))
  await settle()
  expect(messageRequests(server).filter(entry => /^(history|recover)/.test(entry))).toEqual(['history', 'recover after=1'])
  expect(shown(session)).toEqual(['baseline', 'missed while down'])
  expect(openings(server).at(-1)).toBe(`open ${missed.id}`)
})

test('a retry recovers from the checkpoint and never replaces it with a newer initial page', async () => {
  const { server, create } = setup()
  const baseline = server.accept('baseline')
  server.fail('states')
  const session = create()
  await settle()
  expect(session.snapshot().error).toBe('states failed')
  expect(shown(session)).toEqual([])

  const later = server.accept('after the baseline')
  session.retry()
  await settle()
  expect(messageRequests(server)).toEqual([
    'history', `states ${baseline.id}`, 'recover after=1', `states ${baseline.id},${later.id}`, `open ${baseline.id},${later.id}`,
  ])
  expect(session.snapshot().error).toBeNull()
  expect(shown(session)).toEqual(['baseline', 'after the baseline'])
})

test('a failed continuation retries the complete gap', async () => {
  const { server, create } = setup()
  server.accept('recovery baseline')
  const session = create()
  await settle()
  session.connectionChanged(null)
  for (let index = 0; index < 103; index++) server.accept(`gap ${index}`)
  const recover = server.recover.bind(server)
  let failures = 1
  server.recover = cursor => 'cursor' in cursor && failures-- > 0 ? Promise.reject(new Error('Try recovery again')) : recover(cursor)
  session.connectionChanged(Symbol('stream'))
  await settle()
  expect(session.snapshot().error).toBe('Try recovery again')
  expect(shown(session)).toEqual(['recovery baseline'])

  session.retry()
  await settle()
  expect(messageRequests(server).filter(entry => entry.startsWith('recover'))).toEqual(['recover after=1', 'recover after=1', 'recover cursor=101'])
  expect(shown(session)).toEqual(['recovery baseline', ...Array.from({ length: 103 }, (_, index) => `gap ${index}`)])
})

test('live events stay buffered until recovery and the state refresh complete, then apply in arrival order', async () => {
  const { server, create, decrypted } = setup()
  const copy = server.accept('original sender copy', { from: SELF })
  const session = create()
  await settle()
  session.connectionChanged(null)
  const states = server.hold('states')
  session.connectionChanged(Symbol('stream'))
  await settle()
  const first = server.accept('first during refresh')
  const opened = server.openStored(copy.id)
  const second = server.accept('second during refresh')
  session.liveEvent(live(first))
  session.liveEvent({ type: 'expiry-update', data: { ...opened, id: copy.id } })
  session.liveEvent(live(second))
  await settle()
  expect(shown(session)).toEqual([])
  expect(decrypted).not.toContain(first.id)

  states.release()
  await settle()
  expect(decrypted.slice(-2)).toEqual([first.id, second.id])
  expect(shown(session)).toEqual(['original sender copy', 'first during refresh', 'second during refresh'])
  expect(session.snapshot().messages[0]).toMatchObject({ opened_at: opened.opened_at, expires_at: opened.expires_at })
})

test('events arriving during the first clock lookup drain before synchronization completes', async () => {
  const { server, create } = setup()
  const history = server.hold('history')
  const session = create()
  await settle()
  const first = server.accept('first buffered message')
  session.liveEvent(live(first))
  const clock = server.hold('states')
  history.release()
  await settle()
  expect(messageRequests(server)).toEqual(['history', `states ${first.id}`])
  session.liveEvent(live(server.accept('arrived during clock lookup')))
  await settle()
  expect(shown(session)).toEqual([])

  clock.release()
  await settle()
  expect(shown(session)).toEqual(['first buffered message', 'arrived during clock lookup'])
})

test('regaining attention on a stream that stayed synchronized opens what arrived without any other request', async () => {
  const { server, create } = setup()
  server.accept('synchronized before blur')
  const session = create()
  await settle()
  session.attentionChanged(false)
  const sent = server.accept('arrived before refocus')
  session.liveEvent(live(sent))
  await settle()
  expect(shown(session)).toEqual(['synchronized before blur'])
  const before = server.log.length

  session.attentionChanged(true)
  await settle()
  expect(server.log.slice(before)).toEqual([`open ${sent.id}`])
  expect(shown(session)).toEqual(['synchronized before blur', 'arrived before refocus'])
})

test('attention flipping while a resume decrypts loses no buffered message and stays synchronized', async () => {
  const { server, create, holdDecryption } = setup()
  server.accept('synchronized before blur')
  const session = create()
  await settle()
  session.attentionChanged(false)
  const sent = server.accept('arrived while away')
  session.liveEvent(live(sent))
  const decryption = holdDecryption()
  session.attentionChanged(true)
  await settle()
  // Focus-follows-pointer: away and back while the first resume decrypts.
  session.attentionChanged(false)
  session.attentionChanged(true)
  await settle()
  const before = server.log.length

  decryption.release()
  await settle()
  expect(session.snapshot().recovering).toBe(false)
  expect(shown(session)).toEqual(['synchronized before blur', 'arrived while away'])
  expect(server.log.slice(before)).toEqual([`open ${sent.id}`])
})

test('a resume that fails falls back to a full synchronization', async () => {
  const { server, create } = setup()
  const session = create()
  await settle()
  session.attentionChanged(false)
  const sent = server.accept('first message')
  session.liveEvent(live(sent))
  server.fail('states')
  session.attentionChanged(true)
  await settle()
  expect(messageRequests(server)).toEqual(['history', `states ${sent.id}`, 'recover after=0', `states ${sent.id}`, `open ${sent.id}`])
  expect(shown(session)).toEqual(['first message'])
})

const cleared = (clearedAt: number, address = PARTNER) => ({ type: 'conversation-cleared' as const, data: { address, cleared_at: clearedAt } })

test('a conversation cleared while out of sync disappears at once; another conversation clearing changes nothing', async () => {
  const { clock, server, create } = setup()
  const mine = server.accept('opened by her', { from: SELF })
  server.openStored(mine.id)
  const session = create()
  await settle()
  session.attentionChanged(false)
  expect(shown(session)).toEqual(['opened by her'])

  session.liveEvent(cleared(clock.now(), requireAddress('0x' + 'd4'.repeat(20))))
  expect(shown(session)).toEqual(['opened by her'])
  session.liveEvent(cleared(clock.now()))
  expect(shown(session)).toEqual([])
})

test('cleared messages that load later are rejected', async () => {
  const { clock, server, create } = setup()
  server.accept('cleared before loading')
  const history = server.hold('history')
  const session = create()
  await settle()
  session.liveEvent(cleared(clock.now()))
  history.release()
  await settle()
  expect(session.snapshot()).toMatchObject({ messages: [], recovering: false })
  expect(openings(server)).toEqual([])
})

test('clearing resolves with the clear time, and a late response clears nothing in the conversation selected since', async () => {
  const { clock, server, create } = setup()
  server.accept('to be cleared')
  const session = create()
  await settle()
  expect(await session.clear()).toBe(clock.now())
  expect(shown(session)).toEqual([])

  const other = new FakeServer(clock)
  other.accept('in the conversation selected since')
  const clearing = server.hold('clear')
  const late = session.clear()
  session.dispose()
  const next = create(other)
  await settle()
  clearing.release()
  expect(await late).toBe(clock.now())
  expect(shown(next)).toEqual(['in the conversation selected since'])
})

test('one timer runs for the earliest upcoming deadline', async () => {
  const { clock, server, create } = setup()
  server.accept('five seconds', { ttl: 5 })
  server.accept('a minute', { ttl: 60 })
  const session = create()
  await settle()
  expect(clock.timers.map(timer => timer.delay)).toEqual([5_000])

  clock.advance(5_000)
  expect(shown(session)).toEqual(['a minute'])
  expect(clock.timers.map(timer => timer.delay)).toEqual([55_000])
  clock.advance(55_000)
  expect(shown(session)).toEqual([])
  expect(clock.timers).toEqual([])
})

test('a deadline beyond the timer range is clamped to it', async () => {
  const { clock, server, create } = setup()
  clock.time = 10 ** 12
  server.accept('loaded, but the server clock is unknown')
  server.fail('states')
  // Until a state response gives server time, deadlines count from the wall clock.
  spyOn(Date, 'now').mockReturnValue(0)
  const session = create()
  await settle()
  expect(session.snapshot().error).toBe('states failed')
  expect(clock.timers.map(timer => timer.delay)).toEqual([2 ** 31 - 1])
})

test('regaining attention re-checks expiry when background timers ran late', async () => {
  const { clock, server, create } = setup()
  server.accept('opened once', { ttl: 5 })
  const session = create()
  await settle()
  session.attentionChanged(false)
  // A suspended tab's timer does not fire on time.
  clock.time += 5_000
  expect(shown(session)).toEqual(['opened once'])

  session.attentionChanged(true)
  expect(shown(session)).toEqual([])
})

test("a sender copy takes the deadline set by the recipient's opening, which a stale delivery cannot undo", async () => {
  const { clock, server, create } = setup()
  const copy = server.accept('five seconds after opening', { from: SELF, ttl: 5 })
  const session = create()
  await settle()
  clock.advance(1_000)
  const opened = server.openStored(copy.id)
  session.liveEvent({ type: 'expiry-update', data: opened })
  session.liveEvent(live(copy))
  clock.advance(4_999)
  expect(shown(session)).toEqual(['five seconds after opening'])
  clock.advance(1)
  expect(shown(session)).toEqual([])
})

test('forged or inconsistent expiry updates are ignored', async () => {
  const { clock, server, create } = setup()
  const copy = server.accept('keeps its deadline', { from: SELF, ttl: 5 })
  const session = create()
  await settle()
  // Each would expire the copy five seconds after sending if it applied.
  const opened = { ...copy, opened_at: copy.created_at, expires_at: copy.created_at + 5_000 }
  session.liveEvent({ type: 'expiry-update', data: { ...opened, sender: requireAddress('0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3') } })
  session.liveEvent({ type: 'expiry-update', data: { ...opened, expires_at: opened.expires_at - 1 } })
  clock.advance(6_000)
  expect(shown(session)).toEqual(['keeps its deadline'])
})

test('only confirmed openings and your own messages mark the conversation as seen', async () => {
  const { clock, server, create } = setup()
  const incoming = server.accept('unread until opened')
  const opening = server.hold('open')
  const session = create()
  await settle()
  expect(session.snapshot().seenThrough).toBeNull()

  opening.release()
  await settle()
  expect(session.snapshot().seenThrough).toBe(incoming.created_at)
  clock.advance(1_000)
  const mine = server.accept('my own words', { from: SELF })
  session.liveEvent(live(mine))
  await settle()
  expect(session.snapshot().seenThrough).toBe(mine.created_at)
})

test('a failed opening keeps messages hidden and unseen until a retry succeeds', async () => {
  const { server, create } = setup()
  const sent = server.accept('held back')
  server.fail('open')
  const session = create()
  await settle()
  expect(session.snapshot()).toMatchObject({ messages: [], openingFailed: true, seenThrough: null })

  session.retryOpening()
  await settle()
  expect(session.snapshot()).toMatchObject({ openingFailed: false, seenThrough: sent.created_at })
  expect(shown(session)).toEqual(['held back'])
  expect(openings(server)).toEqual([`open ${sent.id}`, `open ${sent.id}`])
})

test('confirmed and unavailable IDs resolve independently; failed ones stay hidden until a retry succeeds', async () => {
  const { server, create } = setup()
  const kept = server.accept('confirmed neighbour')
  const lost = server.accept('needs a retry')
  const gone = server.accept('reported unavailable')
  const open = server.open.bind(server)
  let first = true
  server.open = async ids => {
    const response = await open(ids) as { server_time: number; results: Array<{ id: string }> }
    if (!first) return response
    first = false
    return { ...response, results: response.results
      .filter(result => result.id !== lost.id)
      .map(result => result.id === gone.id ? { id: gone.id, status: 'unavailable' } : result) }
  }
  const session = create()
  await settle()
  expect(shown(session)).toEqual(['confirmed neighbour'])
  expect(session.snapshot().openingFailed).toBe(true)

  session.retryOpening()
  await settle()
  expect(shown(session)).toEqual(['confirmed neighbour', 'needs a retry'])
  expect(session.snapshot().openingFailed).toBe(false)
  expect(openings(server)).toEqual([`open ${kept.id},${lost.id},${gone.id}`, `open ${lost.id}`])
})

test('an opening elsewhere does not reveal plaintext this session has not had confirmed', async () => {
  const { server, create } = setup()
  const sent = server.accept('opened elsewhere')
  const opening = server.hold('open')
  const session = create()
  await settle()
  session.liveEvent({ type: 'expiry-update', data: server.openStored(sent.id) })
  expect(shown(session)).toEqual([])

  opening.release()
  await settle()
  expect(shown(session)).toEqual(['opened elsewhere'])
})

test('only loaded pages open: the newest page on load, older history when it loads', async () => {
  const { server, create } = setup()
  const sent = Array.from({ length: 60 }, (_, index) => server.accept(`history ${index}`))
  const session = create()
  await settle()
  expect(openings(server)).toEqual([`open ${sent.slice(10).map(message => message.id).join(',')}`])
  expect(session.snapshot()).toMatchObject({ hasMore: true })
  expect(shown(session)).toHaveLength(50)

  await session.fetchOlder()
  await settle()
  expect(openings(server)[1]).toBe(`open ${sent.slice(0, 10).map(message => message.id).join(',')}`)
  expect(session.snapshot()).toMatchObject({ hasMore: false, loadingOlder: false })
  expect(shown(session)).toHaveLength(60)
})

test('short initial history does not offer another older page', async () => {
  const { server, create } = setup()
  server.accept('only message')
  const session = create()
  await settle()
  expect(session.snapshot()).toMatchObject({ hasMore: false, loading: false })
})

test('messages received while inattentive open in batches of at most 100 once attention returns', async () => {
  const { server, create } = setup()
  const session = create()
  await settle()
  session.attentionChanged(false)
  for (let index = 0; index < 101; index++) session.liveEvent(live(server.accept(`burst ${index}`)))
  await settle()
  expect(openings(server)).toEqual([])

  session.attentionChanged(true)
  await settle()
  expect(openings(server).map(entry => entry.split(',').length)).toEqual([100, 1])
  expect(shown(session)).toHaveLength(101)
})

const HOUR = 3_600_000

test('changeable deadlines hide while out of sync and return only after an authoritative refresh', async () => {
  const { clock, server, create } = setup()
  const day = { ttl: 86_400 }
  server.accept('final once opened', day)
  const copy = server.accept('awaiting her opening', { ...day, from: SELF })
  clock.advance(2 * HOUR)
  server.accept('still unopened', { ...day, from: SELF })
  const session = create()
  await settle()
  expect(shown(session)).toEqual(['final once opened', 'awaiting her opening', 'still unopened'])

  const states = server.hold('states')
  session.connectionChanged(null)
  expect(shown(session)).toEqual(['final once opened'])
  // Opened elsewhere while this session is out of sync; then the copy's old
  // unopened deadline passes locally, and regaining attention sweeps.
  clock.advance(21 * HOUR)
  server.openStored(copy.id)
  clock.advance(2 * HOUR)
  session.attentionChanged(false)
  session.attentionChanged(true)

  // An open transport alone restores nothing that could have changed.
  session.connectionChanged(Symbol('stream'))
  await settle()
  expect(shown(session)).toEqual(['final once opened'])
  states.release()
  await settle()
  expect(shown(session)).toEqual(['final once opened', 'awaiting her opening', 'still unopened'])
})

test('content recovered during synchronization appears only once it completes', async () => {
  const { clock, server, create } = setup()
  server.accept('expires during recovery', { ttl: 5 })
  const session = create()
  await settle()
  session.connectionChanged(null)
  const copy = server.accept('opened during the gap', { from: SELF })
  server.openStored(copy.id)
  const states = server.hold('states')
  session.connectionChanged(Symbol('stream'))
  await settle()
  // The expiry timer publishes in the middle of synchronization.
  clock.advance(5_000)
  expect(shown(session)).toEqual([])

  states.release()
  await settle()
  expect(shown(session)).toEqual(['opened during the gap'])
})

test.each(['missing result', 'different acceptance', 'different policy'])(
  'an invalid state refresh (%s) keeps changeable content hidden and offers a retry', async invalid => {
  const { server, create } = setup()
  server.accept('needs a valid refresh', { from: SELF })
  const session = create()
  await settle()
  session.connectionChanged(null)
  const states = server.states.bind(server)
  let corrupt = true
  server.states = async ids => {
    const response = await states(ids) as { server_time: number; results: Array<{ status: string; created_at: number; expires_at: number }> }
    if (!corrupt) return response
    corrupt = false
    return { ...response, results: invalid === 'missing result' ? [] : response.results.map(result => invalid === 'different acceptance'
      ? { ...result, created_at: result.created_at - 1, expires_at: result.expires_at - 1 }
      : { ...result, delivery_policy: 'legacy' }) }
  }
  session.connectionChanged(Symbol('stream'))
  await settle()
  expect(session.snapshot()).toMatchObject({ messages: [], recovering: true, error: 'Invalid message state response' })

  session.retry()
  await settle()
  expect(session.snapshot()).toMatchObject({ recovering: false, error: null })
  expect(shown(session)).toEqual(['needs a valid refresh'])
})

test('sending uses the partner key as soon as it loads, before the first synchronization completes', async () => {
  const { server, create } = setup()
  const pubkey = server.hold('pubkey')
  server.hold('history')
  const session = create()
  await expect(session.send('too early', 300)).rejects.toThrow('Recipient has not registered their encryption key yet')
  pubkey.release()
  await settle()
  expect(session.snapshot()).toMatchObject({ recipientPubkey: '0xpubkey', loading: true })
  expect(await session.send('hello', 300)).toMatchObject({ plaintext: 'hello', sender: SELF })
})
