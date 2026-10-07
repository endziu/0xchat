import { requireAddress } from './address'
import { describe, expect, test } from 'bun:test'
import { CLIENT_UPDATE_REQUIRED_CODE } from './api-error'
import { deriveKeypair, signEIP191 } from './keypair'
import {
  canonicalMessageEnvelope,
  DELIVERY_CAPABILITY,
  DELIVERY_CAPABILITY_HEADER,
  UNOPENED_RETENTION_MS,
  type DeliveredMessage,
  type MessageEnvelope,
  type MessageLifecycle,
} from './message-envelope'
import { buildRegistrationChallenge } from './registration-challenge'
import { buildSessionChallenge } from './session-challenge'
import { createSignedMessageEnvelope } from './signed-message-envelope'
import {
  ApiError,
  confirmMessage,
  parseConfirmationResponse,
  ProtocolClient,
  sealMessage,
  unsealMessage,
  type ApiErrorHandler,
} from './protocol-client'

const ORIGIN = 'https://chat.example'
const alice = deriveKeypair(`0x${'11'.repeat(32)}`)
const bob = deriveKeypair(`0x${'22'.repeat(32)}`)
const carol = deriveKeypair(`0x${'33'.repeat(32)}`)
const nonce = 'a1'.repeat(16)
const token = 'ab'.repeat(32)

type Handler = (path: string, init: RequestInit) => Response | Promise<Response>

/** A client whose server answers with `handler`; records every request. */
function client(handler: Handler, onError?: ApiErrorHandler) {
  const requests: { path: string; init: RequestInit }[] = []
  const api = new ProtocolClient(ORIGIN, async (path, init) => {
    requests.push({ path, init })
    return handler(path, init)
  }, onError)
  return { api, requests }
}

const body = (init: RequestInit) => JSON.parse(init.body as string)

function deliver(envelope: MessageEnvelope, lifecycle: Partial<MessageLifecycle> = {}): DeliveredMessage {
  return {
    ...envelope, delivery_policy: 'recipient-opening', created_at: 1_000, opened_at: null,
    expires_at: 1_000 + UNOPENED_RETENTION_MS, ...lifecycle,
  }
}

async function resign(envelope: MessageEnvelope, changes: Partial<MessageEnvelope>): Promise<MessageEnvelope> {
  const { signature: _signature, ...unsigned } = { ...envelope, ...changes }
  return { ...unsigned, signature: await signEIP191(canonicalMessageEnvelope(unsigned), alice.privateKey) }
}

describe('requests', () => {
  test('always advertise the delivery capability, and carry exactly the token passed', async () => {
    const { api, requests } = client(() => Response.json({ conversations: [] }))
    await api.conversations('token-a')
    await api.request('/api/push/vapid-public-key')
    await api.request('/api/events/attention', { method: 'POST', body: { attentive: true }, token: 'token-b' })
    const headers = requests.map(({ init }) => new Headers(init.headers))
    expect(headers.map(header => header.get(DELIVERY_CAPABILITY_HEADER))).toEqual(Array(3).fill(DELIVERY_CAPABILITY))
    expect(headers.map(header => header.get('Authorization'))).toEqual(['Bearer token-a', null, 'Bearer token-b'])
    expect(headers.map(header => header.get('Content-Type'))).toEqual([null, null, 'application/json'])
  })

  test('map an error response to its message and known code', async () => {
    const { api } = client(() => Response.json({ error: 'Unsupported push service', code: 'unsupported_push_service' }, { status: 400 }))
    const error = await api.request('/api/push/subscribe').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ message: 'Unsupported push service', status: 400, code: 'unsupported_push_service' })
  })

  test('map an unreadable or unknown error body to a generic error', async () => {
    for (const response of [
      Response.json(null, { status: 400, statusText: 'Bad Request' }),
      new Response('<html>', { status: 400, statusText: 'Bad Request' }),
      Response.json({ error: 'Bad Request', code: 'not_a_code' }, { status: 400 }),
    ]) {
      const { api } = client(() => response)
      const error = await api.request('/api/conversations').catch((caught: unknown) => caught)
      expect(error).toMatchObject({ message: 'Bad Request', status: 400, code: undefined })
    }
  })

  test('map client_update_required, and throw the error the handler returns instead', async () => {
    const replaced = new Error('update the client')
    const seen: unknown[] = []
    const { api } = client(
      () => Response.json({ error: 'outdated', code: CLIENT_UPDATE_REQUIRED_CODE }, { status: 426 }),
      (error, request) => {
        seen.push(error.code, request)
        return error.code === CLIENT_UPDATE_REQUIRED_CODE ? replaced : undefined
      },
    )
    await expect(api.conversations(token)).rejects.toBe(replaced)
    expect(seen).toEqual([CLIENT_UPDATE_REQUIRED_CODE, { path: '/api/conversations', token }])
  })

  test('parse conversation addresses, and reject invalid ones', async () => {
    const { api } = client(() => Response.json({ conversations: [
      { address: '0x52908400098527886E0F7030069857D2E4169EE7', last_message_at: 123 },
    ] }))
    expect(await api.conversations(token)).toEqual([
      { address: requireAddress('0x52908400098527886e0f7030069857d2e4169ee7'), last_message_at: 123 },
    ])
    const invalid = client(() => Response.json({ conversations: [{ address: 'bad', last_message_at: 123 }] }))
    await expect(invalid.api.conversations(token)).rejects.toThrow('address')
  })
})

describe('keys, registration and sessions', () => {
  test('a fetched encryption key must belong to the address', async () => {
    const { api } = client(() => Response.json({ pubkey: alice.publicKey }))
    expect(await api.pubkey(alice.address)).toBe(alice.publicKey)
    await expect(api.pubkey(bob.address)).rejects.toThrow('Encryption public key does not match address')
    expect(await client(() => Response.json({ pubkey: null })).api.pubkey(bob.address)).toBeNull()
  })

  test('registration signs only a challenge bound to this origin, address and key', async () => {
    for (const [challenge, valid] of [
      [buildRegistrationChallenge(ORIGIN, alice.address, alice.publicKey, nonce), true],
      [buildRegistrationChallenge('https://attacker.example', alice.address, alice.publicKey, nonce), false],
      [buildRegistrationChallenge(ORIGIN, bob.address, alice.publicKey, nonce), false],
      [buildRegistrationChallenge(ORIGIN, alice.address, bob.publicKey, nonce), false],
      [buildRegistrationChallenge(ORIGIN, alice.address, alice.publicKey, 'b2'.repeat(16)), false],
    ] as const) {
      const { api, requests } = client(path => path === '/api/register/challenge'
        ? Response.json({ challenge, nonce })
        : Response.json({ success: true }))
      if (valid) {
        await api.register(alice)
        expect(requests.map(request => request.path)).toEqual(['/api/register/challenge', '/api/register'])
        expect(body(requests[1]!.init)).toMatchObject({ address: alice.address, pubkey: alice.publicKey, nonce })
      } else {
        await expect(api.register(alice)).rejects.toThrow('Invalid registration challenge')
        expect(requests).toHaveLength(1)
      }
    }
  })

  test('login signs only a challenge bound to this origin, address and nonce', async () => {
    for (const challenge of [
      buildSessionChallenge('https://attacker.example', alice.address, nonce),
      buildSessionChallenge(ORIGIN, bob.address, nonce),
      buildSessionChallenge(ORIGIN, alice.address, 'b2'.repeat(16)),
      `0xChat session request\nAddress: ${alice.address}\nNonce: ${nonce}`,
    ]) {
      const { api, requests } = client(() => Response.json({ challenge, nonce }))
      await expect(api.login(alice)).rejects.toThrow('Invalid session challenge')
      expect(requests).toHaveLength(1)
    }
  })

  test('login returns only a well-formed session token', async () => {
    for (const [issued, valid] of [[token, true], ['AB'.repeat(32), false], ['ab', false], [null, false]] as const) {
      const { api } = client(path => path === '/api/auth/challenge'
        ? Response.json({ challenge: buildSessionChallenge(ORIGIN, alice.address, nonce), nonce })
        : Response.json({ token: issued }))
      if (valid) expect(await api.login(alice)).toBe(token)
      else await expect(api.login(alice)).rejects.toThrow('Invalid session token')
    }
  })
})

describe('messages', () => {
  test('sealing rejects messages the server would refuse', async () => {
    await expect(sealMessage(alice, alice.address, alice.publicKey, 'hi', 300)).rejects.toThrow('Cannot message yourself')
    await expect(sealMessage(alice, bob.address, bob.publicKey, 'hi', 301)).rejects.toThrow('Lifetime must be one of')
    await expect(sealMessage(alice, bob.address, bob.publicKey, ' \n', 300)).rejects.toThrow('Message must not be empty')
    await expect(sealMessage(alice, bob.address, bob.publicKey, 'a'.repeat(4097), 300)).rejects.toThrow('Message is too large')
    await expect(sealMessage(alice, bob.address, carol.publicKey, 'hi', 300)).rejects.toThrow('does not match address')
  })

  test('each participant decrypts its own copy', async () => {
    const delivered = deliver(await sealMessage(alice, bob.address, bob.publicKey, 'hello', 300))
    expect((await unsealMessage(alice, delivered, bob.address)).plaintext).toBe('hello')
    expect((await unsealMessage(bob, delivered, alice.address)).plaintext).toBe('hello')
  })

  test('a forged, misaddressed or undecryptable message is rejected', async () => {
    const envelope = await sealMessage(alice, bob.address, bob.publicKey, 'hello', 300)
    const toCarol = await createSignedMessageEnvelope('hello', 300, alice, carol.address, carol.publicKey)
    for (const [identity, input, partner] of [
      [bob, deliver({ ...envelope, signature: `0x${'00'.repeat(65)}` }), alice.address],
      [bob, deliver({ ...envelope, sender: carol.address }), alice.address],
      [bob, { ...deliver(envelope), extra: true }, alice.address],
      [bob, deliver(envelope), carol.address],
      [bob, deliver(toCarol), alice.address],
      [carol, deliver(envelope), alice.address],
    ] as const) {
      await expect(unsealMessage(identity, input, partner)).rejects.toThrow('Rejected unauthenticated or misaddressed message')
    }
    await expect(unsealMessage(bob, deliver(await resign(envelope, { ct_recipient: `0x${'00'.repeat(32)}` })), alice.address))
      .rejects.toThrow('Rejected undecryptable message')
  })

  test('the other participant\'s copy is never decrypted', async () => {
    const envelope = await sealMessage(alice, bob.address, bob.publicKey, 'hello', 300)
    const brokenSenderCopy = deliver(await resign(envelope, { ct_sender: `0x${'00'.repeat(32)}` }))
    const brokenRecipientCopy = deliver(await resign(envelope, { ct_recipient: `0x${'00'.repeat(32)}` }))
    expect((await unsealMessage(bob, brokenSenderCopy, alice.address)).plaintext).toBe('hello')
    expect((await unsealMessage(alice, brokenRecipientCopy, bob.address)).plaintext).toBe('hello')
  })

  test('sending verifies the acknowledgement of exactly the sealed message', async () => {
    const envelope = await sealMessage(alice, bob.address, bob.publicKey, 'hello', 300)
    const other = await sealMessage(alice, bob.address, bob.publicKey, 'other', 300)
    const { api, requests } = client(() => Response.json(deliver(envelope), { status: 201 }))
    expect(await api.send(alice, envelope, token)).toMatchObject({ id: envelope.id, plaintext: 'hello' })
    expect(body(requests[0]!.init)).toEqual(envelope)
    await expect(client(() => Response.json(deliver(other), { status: 201 })).api.send(alice, envelope, token))
      .rejects.toThrow('Invalid message acknowledgement')
  })
})

describe('confirmations', () => {
  const id = `0x${'44'.repeat(16)}`
  const unopened: MessageLifecycle = { delivery_policy: 'recipient-opening', created_at: 1_000, opened_at: null, expires_at: 1_000 + UNOPENED_RETENTION_MS }
  const opened: MessageLifecycle = { ...unopened, opened_at: 2_000, expires_at: 7_000 }
  const message = { id, ttl: 5, ...unopened }
  const response = (results: Record<string, unknown>[], server_time = 2_000) => ({ server_time, results })
  const available = (lifecycle: Partial<MessageLifecycle>) => ({ id, status: 'available', ...unopened, ...lifecycle })

  test('a malformed response is rejected as a whole', () => {
    for (const invalid of [null, 'x', {}, { server_time: -1, results: [] }, { server_time: '2000', results: [] },
      { server_time: 1.5, results: [] }, { server_time: 2_000, results: {} }]) {
      expect(parseConfirmationResponse(invalid)).toBeNull()
    }
    expect(parseConfirmationResponse({ server_time: 2_000, results: [null, 1, { id }] })).toEqual(response([{ id }]))
  })

  test('the single result for a message confirms it, or reports it unavailable', () => {
    expect(confirmMessage(message, response([available(opened)]), 'opening')).toEqual(opened)
    expect(confirmMessage(message, response([available({})]), 'availability')).toEqual(unopened)
    expect(confirmMessage(message, response([{ id, status: 'unavailable' }]), 'opening')).toBe('unavailable')
    expect(confirmMessage({ ...message, ...opened }, response([available(opened)], 6_999), 'availability')).toEqual(opened)
  })

  test('a missing, duplicated or invalid result is rejected', () => {
    for (const [results, kind, server_time] of [
      [[], 'availability', 2_000],
      [[{ ...available({}), id: `0x${'55'.repeat(16)}` }], 'availability', 2_000],
      [[available(opened), available(opened)], 'opening', 2_000],
      [[available(opened), { id, status: 'unavailable' }], 'opening', 2_000],
      [[{ id, status: 'gone' }], 'availability', 2_000],
      [[available({ delivery_policy: 'legacy' as 'recipient-opening' })], 'availability', 2_000],
      // Inconsistent with the signed lifetime or the acceptance.
      [[available({ ...opened, expires_at: 7_001 })], 'opening', 2_000],
      [[available({ created_at: 999, expires_at: 999 + UNOPENED_RETENTION_MS })], 'availability', 2_000],
      // An opening must report the message opened.
      [[available({})], 'opening', 2_000],
      // Nothing can be later than server time, and the deadline must be ahead of it.
      [[available({})], 'availability', 999],
      [[available(opened)], 'opening', 1_999],
      [[available(opened)], 'opening', 7_000],
    ] as const) {
      expect(confirmMessage(message, response([...results], server_time), kind)).toBeNull()
    }
  })

  test('a final deadline never changes', () => {
    const final = { ...message, ...opened }
    expect(confirmMessage(final, response([available({ opened_at: 2_001, expires_at: 7_001 })], 2_001), 'availability')).toBeNull()
    // An unopened result for an opened message is stale; the final deadline stays.
    expect(confirmMessage(final, response([available({})]), 'availability')).toEqual(opened)
  })
})
