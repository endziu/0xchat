import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import * as secp from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { api } from './api'

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

describe('api per-request auth', () => {
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
    await api.getConversations(null)

    expect(seen).toEqual(['Bearer token-a', 'Bearer token-b', null])
  })

  test('a stale or empty-token request does not delete a stored session', async () => {
    // A newer identity just committed its session to storage.
    globalThis.localStorage.setItem(
      'eth_chat_session_v1',
      JSON.stringify({ address: '0xbb', token: 'new-token' }),
    )

    globalThis.fetch = Object.assign(
      async () => new Response(null, { status: 204 }),
      { preconnect: originalFetch.preconnect },
    )

    // An authenticated request issued with the old (now empty) token must
    // neither look up nor clobber the newly stored session.
    await api.getConversations(null)

    const raw = globalThis.localStorage.getItem('eth_chat_session_v1')
    expect(JSON.parse(raw!).token).toBe('new-token')
  })
})
