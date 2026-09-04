import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import * as secp from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ApiError, api } from './api'

const originalFetch = globalThis.fetch
const originalStorage = globalThis.localStorage
const privateKey = `0x${'33'.repeat(32)}` as const
const address = privateKeyToAccount(privateKey).address.toLowerCase()
const publicKey = bytesToHex(secp.getPublicKey(hexToBytes(privateKey), true))

beforeEach(() => {
  const values = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  }
})

afterAll(() => {
  globalThis.fetch = originalFetch
  globalThis.localStorage = originalStorage
})

describe('api.getPubkey', () => {
  test('returns a fetched encryption key only after address verification', async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json({ pubkey: publicKey }),
      { preconnect: originalFetch.preconnect },
    )
    expect(await api.getPubkey(address)).toEqual({ pubkey: publicKey })
  })

  test('rejects a fetched encryption key for another address', async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json({ pubkey: publicKey }),
      { preconnect: originalFetch.preconnect },
    )
    await expect(api.getPubkey(`0x${'44'.repeat(20)}`)).rejects.toThrow(
      'Encryption public key does not match address',
    )
  })
})

describe('api errors', () => {
  test('preserves a stable server error code', async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json(
        { error: 'Unsupported push service', code: 'unsupported_push_service' },
        { status: 400 },
      ),
      { preconnect: originalFetch.preconnect },
    )

    const error = await api.subscribePush(
      { endpoint: 'https://jmt17.google.com/fcm/send/token', keys: {} },
      'token-a',
    ).then(() => null, (caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toBe('Unsupported push service')
    expect((error as ApiError).code).toBe('unsupported_push_service')
  })

  test('turns a null JSON error body into a generic ApiError', async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json(null, { status: 400, statusText: 'Bad Request' }),
      { preconnect: originalFetch.preconnect },
    )

    const error = await api.getConversations('token-a')
      .then(() => null, (caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toBe('Bad Request')
    expect((error as ApiError).code).toBeUndefined()
  })
})

describe('api per-request auth', () => {
  test('deleteSession revokes exactly the bearer token passed by the caller', async () => {
    let seenUrl: unknown
    let seenInit: RequestInit | undefined
    globalThis.fetch = Object.assign(
      async (url: unknown, init?: RequestInit) => {
        seenUrl = url
        seenInit = init
        return new Response(null, { status: 204 })
      },
      { preconnect: originalFetch.preconnect },
    )

    await api.deleteSession('token-a')

    expect(seenUrl).toBe('/api/session')
    expect(seenInit?.method).toBe('DELETE')
    expect(new Headers(seenInit?.headers).get('Authorization')).toBe('Bearer token-a')
  })

  test('sends exactly the token passed per request, with no shared state', async () => {
    const seen: (string | null)[] = []
    globalThis.fetch = Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('Authorization'))
        return new Response(null, { status: 204 })
      },
      { preconnect: originalFetch.preconnect },
    )

    await api.getConversations('token-a')
    await api.getConversations('token-b')
    await api.getVapidPublicKey() // public endpoint: no auth header

    expect(seen).toEqual(['Bearer token-a', 'Bearer token-b', null])
  })

  test('a stale-token 401 does not delete a newer session or sign it out', async () => {
    // A newer identity (B) has committed its session.
    globalThis.localStorage.setItem(
      '0xchat_session_v1',
      JSON.stringify({ address: '0xbb', token: 'token-b' }),
    )
    let expired = 0
    const onExp = () => { expired++ }
    globalThis.addEventListener('auth:expired', onExp)

    globalThis.fetch = Object.assign(
      async () => Response.json({ error: "unauthorized" }, { status: 401 }),
      { preconnect: originalFetch.preconnect },
    )

    // A delayed request still carrying the previous identity (A) token 401s.
    await expect(api.getMessages('0xbb', 'token-a')).rejects.toThrow()

    // B's session survives and B is not signed out.
    expect(JSON.parse(globalThis.localStorage.getItem('0xchat_session_v1')!).token).toBe('token-b')
    expect(expired).toBe(0)
    globalThis.removeEventListener('auth:expired', onExp)
  })

  test('a current-token 401 clears the session and signs out', async () => {
    globalThis.localStorage.setItem(
      '0xchat_session_v1',
      JSON.stringify({ address: '0xbb', token: 'token-b' }),
    )
    let expired = 0
    const onExp = () => { expired++ }
    globalThis.addEventListener('auth:expired', onExp)

    globalThis.fetch = Object.assign(
      async () => Response.json({ error: "unauthorized" }, { status: 401 }),
      { preconnect: originalFetch.preconnect },
    )

    // The active identity's own token is rejected.
    await expect(api.getMessages('0xbb', 'token-b')).rejects.toThrow()

    expect(globalThis.localStorage.getItem('0xchat_session_v1')).toBeNull()
    expect(expired).toBe(1)
    globalThis.removeEventListener('auth:expired', onExp)
  })
})
