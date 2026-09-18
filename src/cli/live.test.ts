import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatClient } from './client'
import { createIdentity, parsePrivateKey } from './identity'
import { initDb, getDb } from '../server/db'
import { createFetch } from '../server/router'
import * as limiters from '../server/rate-limiters'
import * as constants from '../server/constants'
import { UNOPENED_RETENTION_MS } from '../shared/message-envelope'

let directory: string
let identityPath: string
let server: ReturnType<typeof Bun.serve>
let alice: ChatClient
let bob: ChatClient
let clock: ReturnType<typeof spyOn>
let logging: ReturnType<typeof spyOn>
let transform: (request: Request, response: Response) => Promise<Response>
let disconnect: () => void
let replay: () => void
let processes: ReturnType<typeof Bun.spawn>[]
const accepted = Date.now()

beforeEach(async () => {
  initDb(':memory:')
  for (const limiter of Object.values(limiters)) limiter.reset()
  logging = spyOn(constants, 'log').mockImplementation(() => {})
  clock = spyOn(Date, 'now').mockReturnValue(accepted)
  directory = await mkdtemp(join(tmpdir(), '0xchat-live-'))
  identityPath = join(directory, 'bob.json')
  const identity = await createIdentity(identityPath)
  transform = async (_request, response) => response
  processes = []
  const handler = createFetch({ testDeliveryPolicy: 'recipient-opening' })
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request, server) {
    const response = await handler(request, server)
    if (new URL(request.url).pathname !== '/api/events' || !response.ok) return transform(request, response)
    const reader = response.body!.getReader()
    let last: Uint8Array | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        disconnect = () => { controller.close(); void reader.cancel() }
        replay = () => { if (last) controller.enqueue(last) }
        void (async () => {
          try {
            while (true) {
              const item = await reader.read()
              if (item.done) return
              last = item.value
              controller.enqueue(item.value)
            }
          } catch { /* The subprocess closed its stream. */ }
        })()
      },
      cancel() { return reader.cancel() },
    })
    return new Response(stream, { headers: response.headers })
  } })
  alice = new ChatClient(server.url.origin, parsePrivateKey('12'.repeat(32)))
  bob = new ChatClient(server.url.origin, identity)
  await alice.login()
  await bob.login()
})

afterEach(async () => {
  for (const proc of processes) { proc.kill(); await proc.exited; proc.terminal?.close() }
  await Promise.all([alice.close(), bob.close()])
  await server.stop(true)
  clock.mockRestore()
  logging.mockRestore()
  getDb().close()
  for (const limiter of Object.values(limiters)) limiter.reset()
  await rm(directory, { recursive: true, force: true })
})

async function until(check: () => boolean, description: string) {
  const deadline = performance.now() + 3500
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${description}`)
    await Bun.sleep(10)
  }
}

function start(command: 'watch' | 'chat', json = false) {
  let output = ''
  let diagnostics = ''
  const decoder = new TextDecoder()
  const args = [process.execPath, resolve(import.meta.dir, 'main.ts'), '--identity', identityPath,
    '--server', server.url.origin, command, alice.identity.address, ...(json ? ['--json'] : [])]
  const proc = command === 'chat'
    ? Bun.spawn(args, { terminal: { cols: 120, rows: 30, data(_terminal, data) { output += decoder.decode(data, { stream: true }) } } })
    : Bun.spawn(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  processes.push(proc)
  const consume = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    for await (const chunk of stream) append(new TextDecoder().decode(chunk))
  }
  if (proc.stdout instanceof ReadableStream) void consume(proc.stdout, text => { output += text })
  if (proc.stderr instanceof ReadableStream) void consume(proc.stderr, text => { diagnostics += text })
  return { proc, output: () => output, diagnostics: () => diagnostics,
    screen: () => output.split('\x1b[2J\x1b[H').at(-1)! }
}

for (const json of [false, true]) {
  test(`watch ${json ? 'JSON' : 'text'} refreshes lifecycle on reconnect without repeating plaintext`, async () => {
    const sent = await bob.send(alice.identity.address, 'reconnect secret', 5)
    const cli = start('watch', json)
    await until(() => cli.output().includes('reconnect secret'), 'initial history')
    disconnect()
    await until(() => cli.diagnostics().includes('reconnecting'), 'disconnect')
    clock.mockReturnValue(accepted + 1000)
    const opened = (await alice.read(bob.identity.address)).messages[0]!
    await until(() => cli.diagnostics().split('Connected').length === 3, 'reconnected')
    expect(cli.output().match(/reconnect secret/g)).toHaveLength(1)
    if (json) {
      const events = cli.output().trim().split('\n').map(line => JSON.parse(line))
      expect(events.filter(event => event.event === 'expiry-update')).toEqual([
        expect.objectContaining({ id: sent.id, expires_at: opened.expires_at, opened_at: opened.opened_at }),
      ])
      expect(events[1]).not.toHaveProperty('plaintext')
    }
  }, 10_000)
}

test('chat removes expired unopened plaintext while retaining eligibility for a delayed update', async () => {
  await bob.send(alice.identity.address, 'must disappear', 5)
  transform = async (request, response) => {
    if (!new URL(request.url).pathname.endsWith('/state')) return response
    return Response.json({ ...await response.json(), server_time: accepted + UNOPENED_RETENTION_MS - 800 })
  }
  const cli = start('chat')
  await until(() => cli.screen().includes('must disappear'), 'visible sender copy')
  await until(() => !cli.screen().includes('must disappear'), 'expired plaintext removed')
}, 10_000)

for (const json of [false, true]) {
  test(`piped watch ${json ? 'JSON' : 'text'} opens history and live messages once, including concurrent opening`, async () => {
    const history = await alice.send(bob.identity.address, 'history consumed', 5)
    const cli = start('watch', json)
    await until(() => cli.output().includes('history consumed'), 'history output')
    expect((await alice.read(bob.identity.address)).messages.find(message => message.id === history.id)?.opened_at).toBe(accepted)
    let opening = false
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    transform = async (request, response) => {
      if (new URL(request.url).pathname.endsWith('/open')) { opening = true; await barrier }
      return response
    }
    try {
      const live = await alice.send(bob.identity.address, 'live consumed', 5)
      await until(() => opening, 'live opening request')
      expect(cli.output()).not.toContain('live consumed')
      transform = async (_request, response) => response
      const concurrent = (await bob.read(alice.identity.address)).messages.find(message => message.id === live.id)!
      release()
      await until(() => cli.output().includes('live consumed'), 'confirmed live output')
      replay()
      await Bun.sleep(100)
      expect(cli.output().match(/history consumed/g)).toHaveLength(1)
      expect(cli.output().match(/live consumed/g)).toHaveLength(1)
      if (json) {
        const message = cli.output().trim().split('\n').map(line => JSON.parse(line)).find(message => message.id === live.id)
        expect(message.opened_at).toBe(concurrent.opened_at)
        expect(message.expires_at).toBe(concurrent.expires_at)
      }
    } finally { release() }
  }, 10_000)

  test(`watch ${json ? 'JSON' : 'text'} applies live shortened deadlines without repeating plaintext or metadata`, async () => {
    const cli = start('watch', json)
    await until(() => cli.diagnostics().includes('Connected'), 'watch connected')
    const sent = await bob.send(alice.identity.address, 'outgoing live', 5)
    await until(() => cli.output().includes('outgoing live'), 'outgoing message')
    clock.mockReturnValue(accepted + 1000)
    await alice.read(bob.identity.address)
    if (json) await until(() => cli.output().includes('expiry-update'), 'live lifecycle update')
    else await Bun.sleep(100)
    replay()
    replay()
    await Bun.sleep(100)
    expect(cli.output().match(/outgoing live/g)).toHaveLength(1)
    if (json) {
      const events = cli.output().trim().split('\n').map(line => JSON.parse(line))
      expect(events).toHaveLength(2)
      expect(events[1]).toEqual({ event: 'expiry-update', id: sent.id, delivery_policy: 'recipient-opening',
        created_at: accepted, opened_at: accepted + 1000, expires_at: accepted + 6000 })
    }
  }, 10_000)
}

test('failed live opening never prints plaintext', async () => {
  const cli = start('watch', true)
  await until(() => cli.diagnostics().includes('Connected'), 'watch connected')
  transform = async (request, response) => new URL(request.url).pathname.endsWith('/open')
    ? Response.json({ error: 'unavailable' }, { status: 503 }) : response
  await alice.send(bob.identity.address, 'must remain private', 5)
  await until(() => cli.diagnostics().includes('Rejected an invalid message'), 'opening rejected')
  expect(cli.output()).not.toContain('must remain private')
})

test('chat restores a delayed opening extension after the old unopened deadline', async () => {
  await bob.send(alice.identity.address, 'extended sender copy', 5)
  transform = async (request, response) => {
    if (!new URL(request.url).pathname.endsWith('/state')) return response
    return Response.json({ ...await response.json(), server_time: accepted + UNOPENED_RETENTION_MS - 800 })
  }
  const cli = start('chat')
  await until(() => cli.screen().includes('extended sender copy'), 'initial sender copy')
  await until(() => !cli.screen().includes('extended sender copy'), 'old deadline reached')
  clock.mockReturnValue(accepted + UNOPENED_RETENTION_MS - 1)
  await alice.read(bob.identity.address)
  await until(() => cli.screen().includes('extended sender copy'), 'delayed extension restored')
  replay()
  await Bun.sleep(100)
  expect(cli.screen().match(/extended sender copy/g)).toHaveLength(1)
}, 10_000)

test('chat applies a shortened deadline recovered after disconnect', async () => {
  await bob.send(alice.identity.address, 'shortened sender copy', 5)
  const cli = start('chat')
  await until(() => cli.screen().includes('shortened sender copy'), 'initial sender copy')
  disconnect()
  await until(() => cli.screen().includes('reconnecting'), 'disconnect')
  await alice.read(bob.identity.address)
  transform = async (request, response) => {
    if (!new URL(request.url).pathname.endsWith('/state')) return response
    return Response.json({ ...await response.json(), server_time: accepted + 4500 })
  }
  await until(() => cli.screen().includes('Connected'), 'chat reconnected')
  await until(() => !cli.screen().includes('shortened sender copy'), 'recovered deadline expires')
}, 10_000)

test('chat rejects piped input/output', async () => {
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, 'main.ts'), 'chat', alice.identity.address],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  expect(code).toBe(1)
  expect(stderr).toContain('chat requires an interactive terminal')
})

test('chat removes a message that expired on the server during disconnect', async () => {
  await bob.send(alice.identity.address, 'expired offline', 5)
  const cli = start('chat')
  await until(() => cli.screen().includes('expired offline'), 'initial sender copy')
  disconnect()
  await until(() => cli.screen().includes('reconnecting'), 'disconnect')
  await alice.read(bob.identity.address)
  clock.mockReturnValue(accepted + 5000)
  await until(() => cli.screen().includes('Connected'), 'chat reconnected')
  expect(cli.screen()).not.toContain('expired offline')
}, 10_000)

test('interactive chat opens incoming live messages before rendering', async () => {
  const cli = start('chat')
  await until(() => cli.screen().includes('Connected'), 'chat connected')
  const sent = await alice.send(bob.identity.address, 'interactive incoming', 5)
  await until(() => cli.screen().includes('interactive incoming'), 'live message rendered')
  expect((await alice.read(bob.identity.address)).messages.find(message => message.id === sent.id)?.opened_at).toBe(accepted)
  replay()
  await Bun.sleep(100)
  expect(cli.screen().match(/interactive incoming/g)).toHaveLength(1)
})

test('stopping watch during opening prevents late plaintext output', async () => {
  const cli = start('watch', true)
  await until(() => cli.diagnostics().includes('Connected'), 'watch connected')
  let opening = false
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  transform = async (request, response) => {
    if (new URL(request.url).pathname.endsWith('/open')) { opening = true; await barrier }
    return response
  }
  try {
    await alice.send(bob.identity.address, 'cancelled opening', 5)
    await until(() => opening, 'opening started')
    cli.proc.kill('SIGTERM')
    await cli.proc.exited
    release()
    expect(cli.output()).not.toContain('cancelled opening')
  } finally { release() }
})
