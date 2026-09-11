import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatClient } from './client'
import { createIdentity, parsePrivateKey } from './identity'
import { main } from './main'
import { initDb, getDb } from '../server/db'
import { createFetch } from '../server/router'
import * as limiters from '../server/rate-limiters'
import { canonicalMessageEnvelope, type DeliveredMessage, type OpeningResponse } from '../shared/message-envelope'
import { signEIP191 } from '../client/lib/burner'
import { createSignedMessageEnvelope } from '../client/lib/message-envelope'
import * as serverConstants from '../server/constants'

let server: ReturnType<typeof Bun.serve>
let alice: ChatClient
let bob: ChatClient
let clock: ReturnType<typeof spyOn>
let directory: string
let bobPath: string
let legacy: boolean
let openingBodies: string[][]
let stateBodies: string[][]
let transform: (request: Request, response: Response) => Promise<Response>
let serverLog: ReturnType<typeof spyOn>

function isMessageAction(request: Request, action: 'open' | 'state'): boolean {
  return new URL(request.url).pathname.endsWith(`/${action}`)
}

function isMessagePage(request: Request): boolean {
  return request.method === 'GET' && new URL(request.url).pathname.startsWith('/api/messages/')
}

beforeEach(async () => {
  serverLog = spyOn(serverConstants, 'log').mockImplementation(() => {})
  initDb(':memory:')
  for (const limiter of Object.values(limiters)) limiter.reset()
  clock = spyOn(Date, 'now').mockReturnValue(1_000_000)
  directory = await mkdtemp(join(tmpdir(), '0xchat-read-'))
  bobPath = join(directory, 'bob.json')
  const identity = await createIdentity(bobPath)
  openingBodies = []
  stateBodies = []
  legacy = false
  transform = async (_request, response) => response
  const handler = createFetch({ testDeliveryPolicy: 'recipient-opening' })
  const legacyHandler = createFetch()
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request, server) {
    if (isMessageAction(request, 'open')) openingBodies.push((await request.clone().json()).ids)
    if (isMessageAction(request, 'state')) stateBodies.push((await request.clone().json()).ids)
    return transform(request, await (legacy ? legacyHandler : handler)(request, server))
  } })
  alice = new ChatClient(server.url.origin, parsePrivateKey('12'.repeat(32)))
  bob = new ChatClient(server.url.origin, identity)
  await alice.login()
  await bob.login()
})

afterEach(async () => {
  await Promise.all([alice.close(), bob.close()])
  server.stop(true)
  clock.mockRestore()
  serverLog.mockRestore()
  getDb().close()
  for (const limiter of Object.values(limiters)) limiter.reset()
  await rm(directory, { recursive: true, force: true })
})

test('read confirms incoming messages and returns the first opening deadline', async () => {
  const sent = await alice.send(bob.identity.address, 'confirmed', 5)
  clock.mockReturnValue(1_001_000)
  const page = await bob.read(alice.identity.address)
  expect(page.messages).toEqual([expect.objectContaining({ id: sent.id, plaintext: 'confirmed',
    delivery_policy: 'recipient-opening', opened_at: 1_001_000, expires_at: 1_006_000, ttl: 5 })])
  expect(openingBodies).toEqual([[sent.id]])
  clock.mockReturnValue(1_002_000)
  expect((await bob.read(alice.identity.address)).messages[0]?.expires_at).toBe(1_006_000)
})

test('listing and sender reads leave messages unopened; pagination opens only requested pages', async () => {
  for (let index = 0; index < 101; index++) await alice.send(bob.identity.address, `page ${index}`)
  await bob.conversations()
  const senderPage = await alice.read(bob.identity.address)
  expect(senderPage.messages.every(message => message.opened_at === null)).toBe(true)
  expect(openingBodies).toEqual([])
  const latest = await bob.read(alice.identity.address)
  expect(latest.messages).toHaveLength(100)
  expect(openingBodies[0]).toHaveLength(100)
  const older = await bob.read(alice.identity.address, latest.next_before!, latest.next_before_rowid!)
  expect(older.messages.map(message => message.plaintext)).toEqual(['page 0'])
  expect(openingBodies[1]).toEqual([older.messages[0]!.id])
  openingBodies = []
  const history = bob.history(alice.identity.address)
  await history.next()
  expect(openingBodies).toHaveLength(1)
  await history.return(undefined)
  expect(openingBodies).toHaveLength(1)
  openingBodies = []
  const liveHistory = bob.history(alice.identity.address, { confirmAvailability: false })
  await liveHistory.next()
  expect(openingBodies).toEqual([])
  await liveHistory.return(undefined)
}, 20_000)

async function runRead(json = true, all = false) {
  return runCommand(['read', alice.identity.address, ...(json ? ['--json'] : []), ...(all ? ['--all'] : [])])
}

async function runCommand(command: string[]) {
  const lines: string[] = []
  const output = spyOn(console, 'log').mockImplementation(value => { lines.push(String(value)) })
  try {
    await main(['--identity', bobPath, '--server', server.url.origin, ...command])
    return lines.join('\n')
  } finally { output.mockRestore() }
}

test('CLI listing leaves messages unopened and cursor flags open only that page', async () => {
  for (let index = 0; index < 101; index++) await alice.send(bob.identity.address, `command page ${index}`)
  const conversations = JSON.parse(await runCommand(['conversations', '--json']))
  expect(conversations.conversations.some((item: { address: string }) => item.address === alice.identity.address.toLowerCase())).toBe(true)
  expect(openingBodies).toEqual([])

  const latest = JSON.parse(await runRead())
  expect(latest.messages).toHaveLength(100)
  expect(openingBodies[0]).toHaveLength(100)
  openingBodies = []
  const older = JSON.parse(await runCommand(['read', alice.identity.address, '--json',
    '--before', String(latest.next_before), '--before-rowid', String(latest.next_before_rowid)]))
  expect(older.messages.map((message: { plaintext: string }) => message.plaintext)).toEqual(['command page 0'])
  expect(openingBodies).toEqual([[older.messages[0].id]])
}, 20_000)

test('partial and unavailable confirmations never reach text or JSON output', async () => {
  const allowed = await alice.send(bob.identity.address, 'visible\x1b[31m\ntext')
  await alice.send(bob.identity.address, 'unavailable secret')
  await alice.send(bob.identity.address, 'missing secret')
  transform = async (request, response) => {
    if (!isMessageAction(request, 'open')) return response
    const body: OpeningResponse = await response.json()
    return Response.json({ ...body, results: body.results.filter((result, index) => result.id === allowed.id || index === 0)
      .map(result => result.id === allowed.id ? result : { id: result.id, status: 'unavailable' }) })
  }
  expect(JSON.parse(await runRead()).messages.map((message: { plaintext: string }) => message.plaintext)).toEqual(['visible\x1b[31m\ntext'])
  const text = await runRead(false)
  expect(text).toContain('visible\\u001b[31m ↵ text')
  expect(text).not.toContain('secret')
})

test('an opening failure exposes neither plaintext nor the server error body', async () => {
  await alice.send(bob.identity.address, 'private plaintext')
  transform = async (request, response) => isMessageAction(request, 'open')
    ? Response.json({ error: 'private plaintext' }, { status: 503 }) : response
  for (const json of [false, true]) {
    const output = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect(main(['--identity', bobPath, '--server', server.url.origin, 'read', alice.identity.address,
        ...(json ? ['--json'] : [])])).rejects.toThrow('Message opening failed; retry read to confirm availability')
      expect(output).not.toHaveBeenCalled()
    } finally { output.mockRestore() }
  }
})

test('retry after a lost response preserves the committed deadline and cannot revive expiry', async () => {
  await alice.send(bob.identity.address, 'lost response', 5)
  clock.mockReturnValue(1_001_000)
  transform = async (request, response) => isMessageAction(request, 'open')
    ? new Response('{') : response
  await expect(bob.read(alice.identity.address)).rejects.toThrow('Message opening failed')
  transform = async (_request, response) => response
  clock.mockReturnValue(1_003_000)
  expect((await bob.read(alice.identity.address)).messages[0]?.expires_at).toBe(1_006_000)
  clock.mockReturnValue(1_006_000)
  expect((await bob.read(alice.identity.address)).messages).toEqual([])
})

test('all-history output excludes messages that expired while older pages were opened', async () => {
  for (let index = 0; index < 101; index++) await alice.send(bob.identity.address, `secret ${index}`, 5)
  let elapsed = 0
  const monotonicClock = spyOn(performance, 'now').mockImplementation(() => elapsed)
  transform = async (request, response) => {
    if (new URL(request.url).searchParams.has('before')) elapsed = 5_000
    return response
  }
  try {
    const result = JSON.parse(await runRead(true, true))
    expect(result.messages.map((message: { plaintext: string }) => message.plaintext)).toEqual(['secret 0'])
    expect(result.next_before).toBeNull()
    expect(openingBodies.map(ids => ids.length)).toEqual([100, 1])
  } finally { monotonicClock.mockRestore() }
}, 20_000)

test('legacy incoming messages require confirmation without changing their deadline', async () => {
  legacy = true
  const sent = await alice.send(bob.identity.address, 'legacy', 5)
  clock.mockReturnValue(1_001_000)
  const result = await bob.read(alice.identity.address)
  expect(result.messages[0]).toMatchObject({ delivery_policy: 'legacy', opened_at: null, expires_at: 1_005_000 })
  expect(openingBodies).toEqual([[sent.id]])
  transform = async (request, response) => isMessageAction(request, 'open')
    ? Response.json({ server_time: Date.now(), results: [{ id: sent.id, status: 'unavailable' }] }) : response
  expect((await bob.read(alice.identity.address)).messages).toEqual([])
})

for (const corruption of ['signature', 'ciphertext', 'misaddressed']) {
  test(`rejects ${corruption} input before opening or printing any plaintext`, async () => {
    await alice.send(bob.identity.address, 'private plaintext')
    transform = async (request, response) => {
      if (!isMessagePage(request)) return response
      const page: { messages: DeliveredMessage[] } = await response.json()
      const message = page.messages[0]!
      if (corruption === 'signature') message.signature = `0x${'00'.repeat(65)}`
      if (corruption === 'ciphertext') {
        message.ct_recipient = `0x${'00'.repeat(32)}`
        message.signature = await signEIP191(canonicalMessageEnvelope(message), alice.identity.privateKey)
      }
      if (corruption === 'misaddressed') {
        const other = parsePrivateKey('34'.repeat(32))
        Object.assign(message, await createSignedMessageEnvelope('private plaintext', 300, alice.identity, other.address, other.publicKey))
      }
      return Response.json(page)
    }
    expect(JSON.parse(await runRead()).messages).toEqual([])
    expect(await runRead(false)).toBe('')
    expect(openingBodies).toEqual([])
  })
}

test('text output checks expiry separately before each printed message', async () => {
  await alice.send(bob.identity.address, 'first', 5)
  await alice.send(bob.identity.address, 'expires before printing', 5)
  let elapsed = 0
  const monotonicClock = spyOn(performance, 'now').mockImplementation(() => elapsed)
  const lines: string[] = []
  const output = spyOn(console, 'log').mockImplementation(value => {
    lines.push(String(value))
    elapsed = 5_000
  })
  try {
    await main(['--identity', bobPath, '--server', server.url.origin, 'read', alice.identity.address])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('first')
  } finally { output.mockRestore(); monotonicClock.mockRestore() }
})

test('rejects duplicate or invalid lifecycle confirmations without revealing plaintext', async () => {
  await alice.send(bob.identity.address, 'private plaintext')
  for (const fault of ['duplicate', 'unopened', 'deadline', 'server-time']) {
    transform = async (request, response) => {
      if (!isMessageAction(request, 'open')) return response
      const body: OpeningResponse = await response.json()
      const result = body.results[0]!
      if (result.status !== 'available') throw new Error('Expected available fixture')
      if (fault === 'duplicate') body.results.push(result)
      if (fault === 'unopened') { result.opened_at = null; result.expires_at = result.created_at + 86_400_000 }
      if (fault === 'deadline') result.expires_at++
      if (fault === 'server-time') body.server_time = result.expires_at
      return Response.json(body)
    }
    expect((await bob.read(alice.identity.address)).messages).toEqual([])
  }
})

test('JSON output excludes messages that expire during serialization', async () => {
  await alice.send(bob.identity.address, 'expires during serialization', 5)
  let elapsed = 0
  const monotonicClock = spyOn(performance, 'now').mockImplementation(() => elapsed)
  const stringify = JSON.stringify
  const serialization = spyOn(JSON, 'stringify').mockImplementation(value => {
    const result = stringify(value)
    if (value?.messages?.some((message: { plaintext?: string }) => message.plaintext)) elapsed = 5_000
    return result
  })
  try { expect(JSON.parse(await runRead()).messages).toEqual([]) }
  finally { serialization.mockRestore(); monotonicClock.mockRestore() }
})

test('uses server time and elapsed time when the local wall clock is behind', async () => {
  await alice.send(bob.identity.address, 'expired on the server', 5)
  let elapsed = 100
  const monotonicClock = spyOn(performance, 'now').mockImplementation(() => elapsed)
  transform = async (request, response) => {
    if (isMessageAction(request, 'open')) {
      elapsed = 5_100
      clock.mockReturnValue(0)
    }
    return response
  }
  try { expect(JSON.parse(await runRead()).messages).toEqual([]) }
  finally { monotonicClock.mockRestore() }
})

test('does not hide a confirmed message when the local wall clock is ahead', async () => {
  await alice.send(bob.identity.address, 'available on the server', 5)
  transform = async (request, response) => {
    if (isMessageAction(request, 'open')) clock.mockReturnValue(99_000_000)
    return response
  }
  expect(JSON.parse(await runRead()).messages.map((message: { plaintext: string }) => message.plaintext))
    .toEqual(['available on the server'])
})

test('confirms sender-copy availability without opening it or trusting the local clock', async () => {
  const sent = await alice.send(bob.identity.address, 'sender copy', 5)
  transform = async (request, response) => {
    if (isMessageAction(request, 'state')) clock.mockReturnValue(99_000_000)
    return response
  }
  expect((await alice.read(bob.identity.address)).messages.map(message => message.plaintext)).toEqual(['sender copy'])
  expect(openingBodies).toEqual([])
  expect(stateBodies).toEqual([[sent.id]])
})

test('opens and returns valid neighbours when one message is corrupt', async () => {
  const valid = await alice.send(bob.identity.address, 'valid neighbour')
  await alice.send(bob.identity.address, 'corrupt neighbour')
  transform = async (request, response) => {
    if (!isMessagePage(request)) return response
    const page: { messages: DeliveredMessage[] } = await response.json()
    page.messages[0]!.signature = `0x${'00'.repeat(65)}`
    return Response.json(page)
  }
  expect((await bob.read(alice.identity.address)).messages.map(message => message.plaintext)).toEqual(['valid neighbour'])
  expect(openingBodies).toEqual([[valid.id]])
})

test('checks sender copies before opening incoming messages on mixed pages', async () => {
  await alice.send(bob.identity.address, 'incoming')
  await bob.send(alice.identity.address, 'sender copy')
  transform = async (request, response) => isMessageAction(request, 'state')
    ? Response.json({ error: 'state unavailable' }, { status: 503 }) : response
  await expect(bob.read(alice.identity.address)).rejects.toThrow('Message availability check failed')
  expect(openingBodies).toEqual([])
})
