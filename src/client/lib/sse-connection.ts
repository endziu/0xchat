/**
 * SSE connection with explicit reconnect.
 *
 * Browser EventSource does not recover by itself in either failure mode
 * this client can hit:
 *
 * - a non-2xx response (the per-address cap's 429, a stale-token 401) fails
 *   the connection permanently per the HTML standard — readyState is CLOSED
 *   and the browser never re-dials;
 * - a dropped stream is re-dialed by the browser with the *same URL*, but the
 *   token in it is single-use, so the automatic retry gets a 401 and then
 *   dies for good.
 *
 * So recovery is driven here: close the socket, wait with exponential
 * backoff, mint a fresh token, dial again. The seams (token mint,
 * EventSource factory, timers) are injectable so the state machine is
 * testable without a browser or a server.
 */

const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

export interface SseConnectionOptions {
  /** Mint a fresh short-lived SSE token (POST /api/events/token). */
  getSseToken: () => Promise<string>
  /** Build the EventSource URL for a token. */
  buildUrl: (sseToken: string) => string
  /** The socket is open (a 2xx text/event-stream response arrived). */
  onOpen?: () => void
  onMessage?: (data: unknown) => void
  onUserDisconnected?: (address: string) => void
  /** A socket that was open has been lost (fires before the reconnect delay). */
  onDisconnect?: () => void
  // --- test seams (defaults are the production behavior) ---
  createEventSource?: (url: string) => EventSource
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (id: unknown) => void
}

export class SseConnection {
  private readonly getSseToken: () => Promise<string>
  private readonly buildUrl: (sseToken: string) => string
  private readonly onOpen: (() => void) | undefined
  private readonly onMessage: ((data: unknown) => void) | undefined
  private readonly onUserDisconnected: ((address: string) => void) | undefined
  private readonly onDisconnect: (() => void) | undefined
  private readonly createEventSource: (url: string) => EventSource
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (id: unknown) => void

  private es: EventSource | null = null
  private timer: unknown = null // pending reconnect delay, or null
  private minting = false // token request in flight
  private backoffMs = INITIAL_BACKOFF_MS
  private closed = false

  constructor(options: SseConnectionOptions) {
    this.getSseToken = options.getSseToken
    this.buildUrl = options.buildUrl
    this.onOpen = options.onOpen
    this.onMessage = options.onMessage
    this.onUserDisconnected = options.onUserDisconnected
    this.onDisconnect = options.onDisconnect
    this.createEventSource = options.createEventSource ?? ((url) => new EventSource(url))
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimeout ?? ((id) => clearTimeout(id as number))
  }

  /** Start (or restart) a connect cycle. No-op once close()d or while minting. */
  connect(): void {
    if (this.closed || this.minting) return
    this.minting = true
    this.getSseToken()
      .then((sseToken) => {
        this.minting = false
        if (this.closed) return
        this.openEventSource(this.buildUrl(sseToken))
      })
      .catch((err) => {
        this.minting = false
        // Mint failed (e.g. rate-limited): socket was never open, so only
        // the backoff changes — retry with a fresh mint.
        console.error('SSE: failed to mint token:', err)
        this.scheduleReconnect()
      })
  }

  /** Tear down. Idempotent; no reconnect is scheduled after this. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    this.es?.close()
    this.es = null
  }

  private openEventSource(url: string): void {
    const es = this.createEventSource(url)
    this.es = es
    let opened = false

    es.addEventListener('open', () => {
      opened = true
      this.backoffMs = INITIAL_BACKOFF_MS
      if (this.timer !== null) {
        this.clearTimer(this.timer)
        this.timer = null
      }
      this.onOpen?.()
    })

    es.addEventListener('message', (e: MessageEvent) => {
      try {
        this.onMessage?.(JSON.parse(e.data))
      } catch (err) {
        console.error('SSE: failed to parse message data:', err)
      }
    })

    es.addEventListener('user:disconnected', (e: MessageEvent) => {
      try {
        this.onUserDisconnected?.((JSON.parse(e.data) as { address: string }).address)
      } catch (err) {
        console.error('SSE: failed to parse disconnect data:', err)
      }
    })

    es.onerror = () => {
      // Ignore events from a socket that has been replaced or closed.
      if (this.es !== es) return
      es.close()
      this.es = null
      if (opened) this.onDisconnect?.()
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    // One pending delay at a time: repeated error events (the browser can
    // fire 'error' more than once while CONNECTING) must not stack retries.
    if (this.closed || this.timer !== null) return
    this.timer = this.setTimer(() => {
      this.timer = null
      this.connect()
    }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
  }
}
