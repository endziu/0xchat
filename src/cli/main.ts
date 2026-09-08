#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { ChatClient, address, serverOrigin, LIFETIMES, type PlainMessage, type MessagePage } from './client'
import { createIdentity, loadIdentity } from './identity'

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
  --server ORIGIN          Default: OXCHAT_SERVER or http://localhost:3000
  --identity FILE          Default: OXCHAT_IDENTITY or ~/.config/0xchat/identity.json
  --ttl SECONDS            Message lifetime (default: 300)
  --json                   Machine-readable JSON (watch emits JSON lines)
  --all                    Read all available history
  --before TIMESTAMP       Older-page cursor from read --json
  --before-rowid ROWID     Tie-break cursor from read --json
  --help                   Show this help

Lifetime choices: ${LIFETIMES.join(', ')} seconds.
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

function displayMessage(message: PlainMessage, identity: string): string {
  const who = message.sender === identity.toLowerCase() ? 'you' : 'peer'
  const text = message.plaintext.startsWith('data:image/') ? '[image attachment — use the browser to view]' : message.plaintext
  return `${new Date(message.created_at).toLocaleTimeString()} ${who}: ${terminalText(text)}`
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
  partner: string,
  signal: AbortSignal,
  receive: (message: PlainMessage) => void,
  status: (text: string) => void,
): Promise<void> {
  const seen = new Map<string, number>()
  const deliver = (message: PlainMessage) => {
    if (seen.has(message.id) || message.expires_at <= Date.now()) return
    seen.set(message.id, message.expires_at)
    receive(message)
  }
  let backoff = 1000
  while (!signal.aborted) {
    try {
      let synced = false
      for await (const event of client.events(signal)) {
        for (const [id, expires] of seen) if (expires <= Date.now()) seen.delete(id)
        if (!synced) {
          // Subscribe first; messages arriving during history fetch remain buffered.
          const history: PlainMessage[] = []
          for await (const page of client.history(partner)) history.unshift(...page)
          history.forEach(deliver)
          synced = true
          backoff = 1000
          status('Connected')
        }
        if (event.event === 'message') {
          const input: unknown = JSON.parse(event.data)
          // Other conversations share this stream; only open the selected one.
          if (!input || typeof input !== 'object' || !('sender' in input) || !('recipient' in input)) continue
          const me = client.identity.address.toLowerCase()
          if (!((input.sender === me && input.recipient === partner) || (input.sender === partner && input.recipient === me))) continue
          try {
            const message = await client.decode(input, partner)
            if (message) deliver(message)
          } catch { status('Rejected an invalid message') }
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

async function chat(client: ChatClient, partner: string, ttl: number, controller: AbortController): Promise<void> {
  const messages = new Map<string, PlainMessage>()
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 0 })
  let status = 'Connecting…'
  let sending = false
  process.stdout.write('\x1b[?1049h')
  const render = () => {
    for (const [id, message] of messages) if (message.expires_at <= Date.now()) messages.delete(id)
    const width = Math.max(10, (process.stdout.columns || 80) - 1)
    const rows = Math.max(1, (process.stdout.rows || 24) - 6)
    const lines = [...messages.values()].sort((a, b) => a.created_at - b.created_at)
      .slice(-rows).flatMap(message => Bun.wrapAnsi(displayMessage(message, client.identity.address), width, { hard: true }).split('\n'))
      .slice(-rows)
    process.stdout.write('\x1b[2J\x1b[H' + [
      `0xChat · ${partner}`, `Lifetime: ${ttl}s · /quit /ttl /help`, terminalText(status), '', ...lines, '',
    ].map(line => clipLine(line, width)).join('\n') + '\n')
    rl.setPrompt('> ')
    rl.prompt(true)
  }
  const timer = setInterval(() => {
    if ([...messages.values()].some(message => message.expires_at <= Date.now())) render()
  }, 250)
  const onResize = () => render()
  process.stdout.on('resize', onResize)
  rl.on('SIGINT', () => controller.abort())
  rl.on('close', () => controller.abort())
  let pendingSend = Promise.resolve()
  rl.on('line', line => {
    if (line === '/quit') { controller.abort(); return }
    if (line === '/help') { status = 'Enter sends text. /ttl SECONDS changes lifetime. /quit exits.'; render(); return }
    if (line.startsWith('/ttl ')) {
      const value = Number(line.slice(5))
      if (LIFETIMES.includes(value)) { ttl = value; status = 'Lifetime updated' }
      else status = `Choose: ${LIFETIMES.join(', ')}`
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
    }).catch(error => { status = `Send failed: ${error instanceof Error ? error.message : 'unknown error'}` })
      .finally(() => { sending = false; if (!controller.signal.aborted) render() })
  })
  render()
  try {
    await follow(client, partner, controller.signal, message => { messages.set(message.id, message); render() }, text => { status = text; render() })
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
    'key-file': { type: 'string' }, before: { type: 'string' }, 'before-rowid': { type: 'string' },
  } })
  if (values.help || positionals.length === 0) { console.log(HELP); return }
  const [command, partnerArg, ...textArgs] = positionals
  if (!['init', 'import', 'address', 'export', 'register', 'conversations', 'send', 'read', 'watch', 'chat'].includes(command!)) {
    throw new Error(`Unknown command: ${command}. Use --help.`)
  }
  const needsPartner = ['send', 'read', 'watch', 'chat'].includes(command!)
  const partner = needsPartner ? address(partnerArg ?? '') : ''
  if (!needsPartner && partnerArg !== undefined || command !== 'send' && textArgs.length) throw new Error('Unexpected positional arguments')
  if (values['key-file'] !== undefined && command !== 'import') throw new Error('--key-file is only valid with import')
  if ((values.all || values.before || values['before-rowid']) && command !== 'read') throw new Error('Pagination options are only valid with read')
  if (values.all && (values.before || values['before-rowid'])) throw new Error('--all cannot be combined with page cursors')
  if (values['before-rowid'] && !values.before) throw new Error('--before-rowid requires --before')
  if (command === 'chat' && (values.json || !process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('chat requires an interactive terminal; use send/read/watch for scripts')
  const ttl = positiveInteger(values.ttl, 'Lifetime') ?? 300
  if (!LIFETIMES.includes(ttl)) throw new Error(`Lifetime must be one of: ${LIFETIMES.join(', ')}`)
  const before = positiveInteger(values.before, 'before')
  const rowid = positiveInteger(values['before-rowid'], 'before-rowid')
  const identityPath = resolve(values.identity ?? process.env.OXCHAT_IDENTITY ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), '0xchat', 'identity.json'))
  const server = serverOrigin(values.server ?? process.env.OXCHAT_SERVER ?? 'http://localhost:3000')
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
  if (command === 'address') { output({ address: identity.address }, identity.address); return }
  if (command === 'export') { output({ privateKey: identity.privateKey }, identity.privateKey); return }
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const client = new ChatClient(server, identity, controller.signal)
  try {
    if (['init', 'import', 'register'].includes(command!)) {
      await client.register()
      output({ address: identity.address, server: client.origin }, `Registered ${identity.address}`)
    } else if (command === 'conversations') {
      const result = await client.conversations()
      if (values.json) console.log(JSON.stringify(result))
      else console.log(result.conversations.map(conversation => `${terminalText(conversation.address)}  ${new Date(conversation.last_message_at).toISOString()}`).join('\n') || 'No conversations')
    } else if (command === 'send') {
      let text = textArgs.join(' ')
      if (!text || text === '-') {
        if (process.stdin.isTTY) throw new Error('Provide message text, or pipe it to stdin')
        text = await Bun.stdin.text()
      }
      const result = await client.send(partner, text, ttl)
      output(result, `Sent ${result.id}`)
    } else if (command === 'read') {
      let result: MessagePage
      if (values.all) {
        result = { messages: [], next_before: null, next_before_rowid: null }
        for await (const page of client.history(partner)) result.messages.unshift(...page)
      } else result = await client.read(partner, before, rowid)
      if (values.json) console.log(JSON.stringify(result))
      else for (const message of result.messages) console.log(displayMessage(message, identity.address))
    } else if (command === 'watch') {
      await follow(client, partner, controller.signal,
        message => console.log(values.json ? JSON.stringify(message) : displayMessage(message, identity.address)),
        text => console.error(terminalText(text)))
    } else if (command === 'chat') await chat(client, partner, ttl, controller)
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    await client.close().catch(() => { console.error('Session cleanup failed; it will expire automatically.') })
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(`0xChat: ${terminalText(error instanceof Error ? error.message : 'Unknown error')}`)
    process.exitCode = 1
  })
}
