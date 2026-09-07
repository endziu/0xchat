import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatClient, address, serverOrigin } from './client'
import { createIdentity, loadIdentity, parsePrivateKey } from './identity'
import { terminalText } from './main'
import { createSignedMessageEnvelope } from '../client/lib/message-envelope'
import { decrypt } from '../client/lib/crypto'
import { canonicalMessageAad, verifyDeliveredMessage } from '../shared/message-envelope'
import { Database } from 'bun:sqlite'

let directory: string
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), '0xchat-cli-test-')) })
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

describe('local identity and input boundaries', () => {
  test('creates a private, recoverable identity without overwriting existing keys', async () => {
    const path = join(directory, 'identity.json')
    const created = await createIdentity(path)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await loadIdentity(path)).toEqual(created)
    await expect(createIdentity(path)).rejects.toThrow()
    expect(await loadIdentity(path)).toEqual(created)
    await chmod(path, 0o644)
    await expect(loadIdentity(path)).rejects.toThrow('accessible only')
    await chmod(path, 0o600)
    const link = join(directory, 'link.json')
    await symlink(path, link)
    await expect(loadIdentity(link)).rejects.toThrow()
  })

  test('imports browser-exported keys and rejects malformed or zero keys', async () => {
    const key = '11'.repeat(32)
    expect(parsePrivateKey(` ${key}\n`)).toEqual(parsePrivateKey(`0x${key}`))
    expect(() => parsePrivateKey('not a key')).toThrow()
    expect(() => parsePrivateKey('00'.repeat(32))).toThrow()
    const identity = await createIdentity(join(directory, 'import.json'), key)
    expect(await loadIdentity(join(directory, 'import.json'))).toEqual(identity)
  })

  test('validates server origins and addresses', () => {
    expect(serverOrigin('https://example.com/')).toBe('https://example.com')
    expect(serverOrigin('http://localhost:3000')).toBe('http://localhost:3000')
    for (const url of ['http://example.com', 'https://u:p@example.com', 'https://example.com/api', 'https://example.com/?x=1', 'file:///tmp/a']) {
      expect(() => serverOrigin(url)).toThrow()
    }
    expect(() => address('../conversations')).toThrow()
  })

  test('neutralizes terminal escapes, line injection and bidi controls', () => {
    expect(terminalText('\x1b]52;c;secret\x07\npeer:\u202etest')).toBe('\\u001b]52;c;secret\\u0007 ↵ peer:\\u202etest')
    expect(terminalText('hello 😛')).toBe('hello 😛')
  })

  test('refuses substituted registration/login challenges and mismatched public keys', async () => {
    const identity = parsePrivateKey('33'.repeat(32))
    let mode = 'registration'
    const writes: string[] = []
    const hostile = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
      const path = new URL(request.url).pathname
      if (path.startsWith('/api/pubkey/')) return Response.json({ pubkey: mode === 'key' ? parsePrivateKey('44'.repeat(32)).publicKey : identity.publicKey })
      if (path.endsWith('/challenge')) return Response.json({ challenge: 'Sign a completely different request', nonce: 'ab'.repeat(16) })
      writes.push(path)
      return Response.json({ ok: true })
    } })
    try {
      const client = new ChatClient(hostile.url.origin, identity)
      await expect(client.register()).rejects.toThrow('Invalid registration challenge')
      mode = 'session'
      await expect(client.login()).rejects.toThrow('Invalid session challenge')
      mode = 'key'
      await expect(client.login()).rejects.toThrow('does not match address')
      expect(writes).toEqual([])
    } finally { hostile.stop(true) }
  })
})

describe('unchanged server interoperability', () => {
  let server: ReturnType<typeof Bun.spawn>
  let origin: string
  let alice: ChatClient
  let bob: ChatClient
  const clients: ChatClient[] = []

  beforeAll(async () => {
    const serverDirectory = join(directory, 'server')
    const aliceIdentity = await createIdentity(join(serverDirectory, 'alice.json'))
    const bobIdentity = await createIdentity(join(serverDirectory, 'bob.json'))
    // The server resolves chat.db from cwd. This process never touches the user's DB.
    const port = 20_000 + Math.floor(Math.random() * 30_000)
    origin = `http://localhost:${port}`
    server = Bun.spawn([process.execPath, resolve(import.meta.dir, '../..', 'server.ts')], {
      cwd: serverDirectory,
      env: { ...process.env, PORT: String(port), DEBUG: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' },
      stdout: 'ignore', stderr: 'pipe',
    })
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) {
        const details = server.stderr instanceof ReadableStream ? await new Response(server.stderr).text() : ''
        throw new Error(`Fixture server exited: ${server.exitCode}: ${details}`)
      }
      try {
        const response = await fetch(origin + `/api/pubkey/${aliceIdentity.address}`)
        if (response.ok) { ready = true; break }
      } catch { /* Wait for the isolated server to listen. */ }
      await Bun.sleep(50)
    }
    if (!ready) throw new Error('Fixture server did not start')
    alice = new ChatClient(origin, aliceIdentity)
    bob = new ChatClient(origin, bobIdentity)
    clients.push(alice, bob)
    await alice.login()
    await bob.login()
  }, 10_000)

  afterAll(async () => {
    await Promise.all(clients.map(client => client.close().catch(() => {})))
    if (server) { server.kill(); await server.exited }
  })

  test('CLI send decrypts with browser crypto; browser send decrypts in CLI', async () => {
    const sent = await alice.send(bob.identity.address, 'hello from CLI 😛', 300)
    const received = await bob.read(alice.identity.address)
    expect(received.messages.find(message => message.id === sent.id)?.plaintext).toBe('hello from CLI 😛')
    const token = await browserSession(alice)
    try {
      const rawPage = await fetch(origin + `/api/messages/${bob.identity.address}`, { headers: { Authorization: `Bearer ${token}` } }).then(response => response.json()) as { messages: unknown[] }
      const envelope = await verifyDeliveredMessage(rawPage.messages[0])
      expect(envelope).not.toBeNull()
      expect(await decrypt(envelope!.ct_sender, envelope!.ephemeral_pub_sender, envelope!.iv_sender, alice.identity.privateKey, canonicalMessageAad(envelope!))).toBe('hello from CLI 😛')
      const browserMessage = await createSignedMessageEnvelope('hello from browser', 300, alice.identity, bob.identity.address, bob.identity.publicKey)
      const response = await fetch(origin + '/api/messages', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(browserMessage) })
      expect(response.status).toBe(201)
      const delivered = await response.json()
      expect((await bob.decode(delivered, alice.identity.address))?.plaintext).toBe('hello from browser')
      await expect(bob.decode({ ...delivered, sender: bob.identity.address.toLowerCase() }, alice.identity.address)).rejects.toThrow()
      await expect(bob.decode(delivered, parsePrivateKey('22'.repeat(32)).address)).rejects.toThrow()
    } finally {
      await fetch(origin + '/api/session', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    }
    expect((await bob.conversations()).conversations.some(conversation => conversation.address === alice.identity.address.toLowerCase())).toBe(true)
  })

  async function browserSession(client: ChatClient): Promise<string> {
    const { signEIP191 } = await import('../client/lib/burner')
    const challenge = await fetch(origin + '/api/auth/challenge', { method: 'POST', body: JSON.stringify({ address: client.identity.address }) }).then(response => response.json()) as { challenge: string; nonce: string }
    const response = await fetch(origin + '/api/auth/session', { method: 'POST', body: JSON.stringify({ address: client.identity.address, nonce: challenge.nonce, signature: await signEIP191(challenge.challenge, client.identity.privateKey) }) })
    return ((await response.json()) as { token: string }).token
  }

  test('receives encrypted live events, cancels, and reconnects', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const events = bob.events(controller.signal)
      try {
        expect((await events.next()).value?.event).toBe('ping')
        const next = events.next()
        const sent = await alice.send(bob.identity.address, `live ${attempt}`)
        const event = (await next).value!
        expect(event.event).toBe('message')
        expect((await bob.decode(JSON.parse(event.data), alice.identity.address))?.id).toBe(sent.id)
      } finally { controller.abort(); await events.return(undefined) }
    }
  })

  test('uses both pagination cursors without dropping messages', async () => {
    for (let i = 0; i < 101; i++) await alice.send(bob.identity.address, `page ${i}`)
    const latest = await bob.read(alice.identity.address)
    expect(latest.messages).toHaveLength(100)
    const older = await bob.read(alice.identity.address, latest.next_before!, latest.next_before_rowid!)
    expect(older.messages.length).toBeGreaterThan(0)
    const ids: string[] = []
    for await (const page of bob.history(alice.identity.address)) ids.push(...page.map(message => message.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(latest.messages.length + older.messages.length)
  }, 20_000)

  test('CLI subprocesses support stdin, JSON, offline identity, and clean failures', async () => {
    const identityPath = join(directory, 'server', 'bob.json')
    const run = async (args: string[], input?: string) => {
      const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, 'main.ts'), '--identity', identityPath, '--server', origin, ...args], {
        stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      return { stdout, stderr, code }
    }
    const offline = await run(['address', '--json'])
    expect(offline.code).toBe(0)
    expect(JSON.parse(offline.stdout).address).toBe(bob.identity.address)
    const sent = await run(['send', alice.identity.address, '--json'], 'piped\nmessage')
    expect(sent.code).toBe(0)
    expect(JSON.parse(sent.stdout).plaintext).toBe('piped\nmessage')
    const read = await run(['read', alice.identity.address, '--json', '--all'])
    expect(read.code).toBe(0)
    expect(JSON.parse(read.stdout).messages.some((message: { plaintext: string }) => message.plaintext === 'piped\nmessage')).toBe(true)
    const invalid = await run(['send', 'bad-address', 'hello'])
    expect(invalid.code).toBe(1)
    expect(invalid.stderr).toContain('Expected an Ethereum address')
    const stored = await readFile(identityPath, 'utf8')
    expect(stored).not.toContain('token')
  }, 10_000)

  test('expired messages disappear from history', async () => {
    const sent = await bob.send(alice.identity.address, 'short lived', 5)
    expect((await alice.read(bob.identity.address)).messages.some(message => message.id === sent.id)).toBe(true)
    await Bun.sleep(5100)
    expect((await alice.read(bob.identity.address)).messages.some(message => message.id === sent.id)).toBe(false)
  }, 10_000)

  test('renews an invalidated session without losing the operation', async () => {
    const db = new Database(join(directory, 'server', 'chat.db'))
    try { db.query('DELETE FROM sessions WHERE address = ?').run(bob.identity.address.toLowerCase()) }
    finally { db.close() }
    const sent = await bob.send(alice.identity.address, 'after session renewal')
    expect((await alice.read(bob.identity.address)).messages.find(message => message.id === sent.id)?.plaintext).toBe('after session renewal')
  })
})
