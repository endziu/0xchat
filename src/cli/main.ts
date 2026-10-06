#!/usr/bin/env bun
import { checksumAddress, requireAddress, type Address } from '../shared/address'
import { MESSAGE_TTLS } from '../shared/message-ttl'
import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { ChatClient, ClientUpdateRequiredError, applyExpiryUpdate, isMessageAvailable, shouldRetainMessage, serverOrigin, type PlainMessage, type MessagePage } from './client'
import { createIdentity, loadIdentity } from './identity'
import { parseLiveEvent } from '../shared/live-events'
import { isEnvelopeParticipant } from '../shared/message-envelope'

const HELP = `0xChat CLI — encrypted chat with the existing 0xChat server

Usage: bun run cli [options] <command> [arguments]

  init                     Create and register a fresh burner identity
  import --key-file FILE   Import a raw hex private key (use - for stdin)
  address                  Print your identity's address (offline)
  export                   Print your private key to stdout (offline)
  register                 Register an existing identity on this server
  conversations            List conversation partners
  send ADDRESS [TEXT]      Send text; omit TEXT or use - to read stdin
  read ADDRESS             Read the latest 100 messages, oldest first
  watch ADDRESS            Stream history and live messages until Ctrl-C
  chat ADDRESS             Interactive chat; /quit, /ttl SECONDS, /help

Options:
  --server ORIGIN          prod, local, or an explicit origin (HTTPS remotely)
                           prod = https://chat.endziu.xyz
                           local = http://localhost:3000
                           Default: OXCHAT_SERVER or local
  --identity FILE          Default: OXCHAT_IDENTITY or ~/.config/0xchat/identity.json
  --ttl SECONDS            Message lifetime (default: 300)
  --json                   Machine-readable JSON (watch emits JSON lines)
  --all                    Read all available history
  --before SEQ             Older-page cursor (next_before_seq from read --json)
  --help                   Show this help

Lifetime choices: ${MESSAGE_TTLS.join(', ')} seconds.
Identity files contain an unencrypted private key and are created with mode 600.
Use a dedicated burner key. Output from read/watch can remain in terminal logs.
`

// Never let peer-controlled text send terminal commands or disguise direction.
export function terminalText(value: string): string {
  // eslint-disable-next-line no-control-regex -- terminal escape sequences are untrusted input
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, char => {
    if (char === '\n') return ' ↵ '
    if (char === '\t') return '  '
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

function displayMessage(message: PlainMessage, identity: Address): string {
  const who = message.sender === identity ? 'you' : 'peer'
  return `${new Date(message.created_at).toLocaleTimeString()} ${who}: ${terminalText(message.plaintext)}`
}

function clipLine(value: string, width: number): string {
  let result = ''
  let used = 0
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
    used += Bun.stringWidth(segment)
    if (used > width) break
    result += segment
  }
  return result
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`)
  return number
}

async function follow(
  client: ChatClient,
  partner: Address,
  receive: (message: PlainMessage) => void,
  lifecycle: (message: PlainMessage) => void,
  status: (text: string) => void,
  unavailable: (id: string) => void = () => {},
): Promise<void> {
  const { signal } = client
  const seen = new Map<string, PlainMessage>()
  const deliver = (message: PlainMessage) => {
    if (signal.aborted || !isMessageAvailable(message)) return
    const previous = seen.get(message.id)
    if (previous) {
      const changed = previous.opened_at !== message.opened_at || previous.expires_at !== message.expires_at
      // Preserve the object shared with chat while refreshing its monotonic deadline.
      Object.assign(previous, message)
      if (changed) lifecycle(previous)
    } else {
      seen.set(message.id, message)
      receive(message)
    }
  }
  let backoff = 1000
  while (!signal.aborted) {
    try {
      let synced = false
      for await (const frame of client.events(signal)) {
        if (signal.aborted) return
        for (const [id, message] of seen) {
          if (!shouldRetainMessage(message)) seen.delete(id)
        }
        if (!synced) {
          // Subscribe first; messages arriving during history fetch remain buffered.
          const history: PlainMessage[] = []
          for await (const page of client.history(partner)) history.unshift(...page)
          if (signal.aborted) return
          const availableIds = new Set(history.filter(isMessageAvailable).map(message => message.id))
          for (const id of seen.keys()) {
            if (!availableIds.has(id)) { seen.delete(id); unavailable(id) }
          }
          history.forEach(deliver)
          synced = true
          backoff = 1000
          status('Connected')
        }
        const event = parseLiveEvent(frame.event, frame.data)
        // Pings, unknown and malformed events never alter displayed messages.
        if (!event) continue
        switch (event.type) {
          case 'message':
            // Other conversations share this stream; only open the selected one.
            if (!isEnvelopeParticipant(event.data, client.identity.address, partner)) break
            try {
              const message = await client.confirmLiveMessage(partner, event.data)
              if (message) deliver(message)
            } catch {
              if (signal.aborted) return
              status('Rejected an invalid message')
            }
            break
          case 'expiry-update': {
            const message = seen.get(event.data.id)
            if (!signal.aborted && message && applyExpiryUpdate(message, event.data)) lifecycle(message)
            break
          }
          case 'conversation-cleared':
            if (event.data.address !== partner) break
            for (const [id, message] of seen) {
              if (message.created_at <= event.data.cleared_at) { seen.delete(id); unavailable(id) }
            }
            status('Conversation cleared')
            break
          // A partner who deleted their registration changes nothing on screen.
          case 'user:disconnected':
            break
          default:
            event satisfies never
        }
      }
      if (!signal.aborted) throw new Error('Live connection closed')
    } catch (error) {
      if (signal.aborted) return
      status(`${error instanceof Error ? error.message : 'Connection failed'}; reconnecting in ${backoff / 1000}s`)
      await delay(backoff, undefined, { signal }).catch(() => {})
      backoff = Math.min(backoff * 2, 30_000)
    }
  }
}

async function chat(client: ChatClient, partner: Address, ttl: number): Promise<void> {
  const messages = new Map<string, PlainMessage>()
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 0 })
  let status = 'Connecting…'
  let sending = false
  let visible = new Set<PlainMessage>()
  process.stdout.write('\x1b[?1049h')
  const render = () => {
    for (const [id, message] of messages) {
      if (!shouldRetainMessage(message)) messages.delete(id)
    }
    const width = Math.max(10, (process.stdout.columns || 80) - 1)
    const rows = Math.max(1, (process.stdout.rows || 24) - 6)
    visible = new Set([...messages.values()].filter(isMessageAvailable))
    const lines = [...visible].sort((a, b) => a.created_at - b.created_at)
      .slice(-rows).flatMap(message => Bun.wrapAnsi(displayMessage(message, client.identity.address), width, { hard: true }).split('\n'))
      .slice(-rows)
    process.stdout.write('\x1b[2J\x1b[H' + [
      `0xChat · ${checksumAddress(partner)}`, `Lifetime: ${ttl}s · /quit /ttl /help`, terminalText(status), '', ...lines, '',
    ].map(line => clipLine(line, width)).join('\n') + '\n')
    rl.setPrompt('> ')
    rl.prompt(true)
  }
  const timer = setInterval(() => {
    if ([...visible].some(message => !isMessageAvailable(message))) render()
  }, 250)
  const onResize = () => render()
  process.stdout.on('resize', onResize)
  rl.on('SIGINT', () => client.abort())
  rl.on('close', () => client.abort())
  let pendingSend = Promise.resolve()
  rl.on('line', line => {
    if (line === '/quit') { client.abort(); return }
    if (line === '/help') { status = 'Enter sends text. /ttl SECONDS changes lifetime. /quit exits.'; render(); return }
    if (line.startsWith('/ttl ')) {
      const value = Number(line.slice(5))
      if (MESSAGE_TTLS.includes(value)) { ttl = value; status = 'Lifetime updated' }
      else status = `Choose: ${MESSAGE_TTLS.join(', ')}`
      render(); return
    }
    if (!line.trim()) { render(); return }
    if (sending) { status = 'Still sending; your next line is kept in the prompt'; rl.write(line); render(); return }
    sending = true
    status = 'Sending…'
    render()
    pendingSend = client.send(partner, line, ttl).then(message => {
      messages.set(message.id, message)
      status = 'Sent'
    }).catch(error => {
      status = `Send failed: ${error instanceof Error ? error.message : 'unknown error'}`
    })
      .finally(() => { sending = false; if (!client.signal.aborted) render() })
  })
  render()
  try {
    await follow(client, partner,
      message => { messages.set(message.id, message); render() },
      message => { messages.set(message.id, message); render() },
      text => { status = text; render() },
      id => { messages.delete(id); render() })
  } finally {
    clearInterval(timer)
    process.stdout.off('resize', onResize)
    rl.close()
    process.stdout.write('\x1b[?1049l')
    await pendingSend
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    server: { type: 'string' }, identity: { type: 'string' }, ttl: { type: 'string' },
    json: { type: 'boolean' }, all: { type: 'boolean' }, help: { type: 'boolean' },
    'key-file': { type: 'string' }, before: { type: 'string' },
  } })
  if (values.help || positionals.length === 0) { console.log(HELP); return }
  const [command, partnerArg, ...textArgs] = positionals
  if (!['init', 'import', 'address', 'export', 'register', 'conversations', 'send', 'read', 'watch', 'chat'].includes(command!)) {
    throw new Error(`Unknown command: ${command}. Use --help.`)
  }
  const needsPartner = ['send', 'read', 'watch', 'chat'].includes(command!)
  const partner = needsPartner ? requireAddress(partnerArg ?? '') : null
  if (!needsPartner && partnerArg !== undefined || command !== 'send' && textArgs.length) throw new Error('Unexpected positional arguments')
  if (values['key-file'] !== undefined && command !== 'import') throw new Error('--key-file is only valid with import')
  if ((values.all || values.before) && command !== 'read') throw new Error('Pagination options are only valid with read')
  if (values.all && values.before) throw new Error('--all cannot be combined with --before')
  if (command === 'chat' && (values.json || !process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('chat requires an interactive terminal; use send/read/watch for scripts')
  const ttl = positiveInteger(values.ttl, 'Lifetime') ?? 300
  if (!MESSAGE_TTLS.includes(ttl)) throw new Error(`Lifetime must be one of: ${MESSAGE_TTLS.join(', ')}`)
  const before = positiveInteger(values.before, 'before')
  const identityPath = resolve(values.identity ?? process.env.OXCHAT_IDENTITY ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), '0xchat', 'identity.json'))
  const server = serverOrigin(values.server ?? process.env.OXCHAT_SERVER ?? 'local')
  const output = (value: unknown, text: string) => console.log(values.json ? JSON.stringify(value) : terminalText(text))
  let identity
  if (command === 'init' || command === 'import') {
    let key: string | undefined
    if (command === 'import') {
      const path = values['key-file']
      if (!path) throw new Error('import requires --key-file FILE (or - for stdin)')
      if (path === '-' && process.stdin.isTTY) throw new Error('Pipe the private key to stdin, or use a key file')
      key = await (path === '-' ? Bun.stdin : Bun.file(path)).text()
    }
    identity = await createIdentity(identityPath, key)
    console.error(`Identity saved to ${terminalText(identityPath)}. Back up this file; it is your private key.`)
  } else {
    try { identity = await loadIdentity(identityPath) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('No identity found. Run init, or select one with --identity FILE.')
      throw error
    }
  }
  if (command === 'address') { output({ address: identity.address }, checksumAddress(identity.address)); return }
  if (command === 'export') { output({ privateKey: identity.privateKey }, identity.privateKey); return }
  const client = new ChatClient(server, identity)
  const stop = () => client.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  let failure: unknown = null
  try {
    if (['init', 'import', 'register'].includes(command!)) {
      await client.register()
      output({ address: identity.address, server: client.origin }, `Registered ${checksumAddress(identity.address)} on ${client.origin}`)
    } else if (command === 'conversations') {
      const result = await client.conversations()
      if (values.json) console.log(JSON.stringify(result))
      else console.log(result.conversations.map(conversation => `${checksumAddress(conversation.address)}  ${new Date(conversation.last_message_at).toISOString()}`).join('\n') || 'No conversations')
    } else if (command === 'send') {
      let text = textArgs.join(' ')
      if (!text || text === '-') {
        if (process.stdin.isTTY) throw new Error('Provide message text, or pipe it to stdin')
        text = await Bun.stdin.text()
      }
      const result = await client.send(partner!, text, ttl)
      output(result, `Sent ${result.id}`)
    } else if (command === 'read') {
      let result: MessagePage
      if (values.all) {
        result = { messages: [], next_before_seq: null }
        for await (const page of client.history(partner!)) result.messages.unshift(...page)
      } else result = await client.read(partner!, before)
      if (values.json) {
        let serialized: string
        do {
          result.messages = result.messages.filter(isMessageAvailable)
          // Large all-history results can cross a deadline during serialization.
          serialized = JSON.stringify(result)
        } while (result.messages.some(message => !isMessageAvailable(message)))
        console.log(serialized)
      } else for (const message of result.messages) {
        const text = displayMessage(message, identity.address)
        if (isMessageAvailable(message)) console.log(text)
      }
    } else if (command === 'watch') {
      await follow(client, partner!,
        message => console.log(values.json ? JSON.stringify(message) : displayMessage(message, identity.address)),
        message => {
          if (values.json) console.log(JSON.stringify({
            event: 'expiry-update', id: message.id, delivery_policy: message.delivery_policy,
            created_at: message.created_at, opened_at: message.opened_at, expires_at: message.expires_at,
          }))
        },
        text => console.error(terminalText(text)))
    } else if (command === 'chat') await chat(client, partner!, ttl)
  } catch (error) {
    // Ctrl-C and leaving chat abort the client and end quietly.
    if (!client.signal.aborted) failure = error
  } finally {
    await client.close().catch(() => { console.error('Session cleanup failed; it will expire automatically.') })
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
  // A refused client aborts itself; report the update action however the command ended.
  if (client.signal.reason instanceof ClientUpdateRequiredError) failure = client.signal.reason
  if (failure === null) return
  if (command === 'init' || command === 'import') {
    console.error(`Identity remains saved at ${terminalText(identityPath)}. Run register with the same --identity and chosen --server options to retry; do not run init again.`)
  }
  throw failure
}

if (import.meta.main) {
  main().catch(error => {
    console.error(`0xChat: ${terminalText(error instanceof Error ? error.message : 'Unknown error')}`)
    process.exitCode = 1
  })
}
