import { requireAddress } from '../../shared/address'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { api, CLIENT_UPDATE_REQUIRED_EVENT } from './api'
import { CLIENT_UPDATE_REQUIRED_CODE } from '../../shared/api-error'

const originalFetch = globalThis.fetch
const originalStorage = globalThis.localStorage

// Bun has no `window`; the client binds challenges to `window.location.origin`.
const TEST_ORIGIN = 'https://app.example'
const originalWindow = globalThis.window as unknown

beforeAll(() => {
  globalThis.window = { location: { origin: TEST_ORIGIN } } as unknown as Window & typeof globalThis
})

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
  globalThis.window = originalWindow as Window & typeof globalThis
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
        return Response.json({ conversations: [] })
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
      JSON.stringify({ address: requireAddress('0xbb00000000000000000000000000000000000000'), token: 'token-b' }),
    )
    let expired = 0
    const onExp = () => { expired++ }
    globalThis.addEventListener('auth:expired', onExp)

    globalThis.fetch = Object.assign(
      async () => Response.json({ error: "unauthorized" }, { status: 401 }),
      { preconnect: originalFetch.preconnect },
    )

    // A delayed request still carrying the previous identity (A) token 401s.
    await expect(api.getMessages(requireAddress('0xbb00000000000000000000000000000000000000'), 'token-a')).rejects.toThrow()

    // B's session survives and B is not signed out.
    expect(JSON.parse(globalThis.localStorage.getItem('0xchat_session_v1')!).token).toBe('token-b')
    expect(expired).toBe(0)
    globalThis.removeEventListener('auth:expired', onExp)
  })

  test('a current-token 401 clears the session and signs out', async () => {
    globalThis.localStorage.setItem(
      '0xchat_session_v1',
      JSON.stringify({ address: requireAddress('0xbb00000000000000000000000000000000000000'), token: 'token-b' }),
    )
    let expired = 0
    const onExp = () => { expired++ }
    globalThis.addEventListener('auth:expired', onExp)

    globalThis.fetch = Object.assign(
      async () => Response.json({ error: "unauthorized" }, { status: 401 }),
      { preconnect: originalFetch.preconnect },
    )

    // The active identity's own token is rejected.
    await expect(api.getMessages(requireAddress('0xbb00000000000000000000000000000000000000'), 'token-b')).rejects.toThrow()

    expect(globalThis.localStorage.getItem('0xchat_session_v1')).toBeNull()
    expect(expired).toBe(1)
    globalThis.removeEventListener('auth:expired', onExp)
  })
})

test('a client update requirement is announced to the page', async () => {
  let announced = 0
  const onUpdate = () => { announced++ }
  globalThis.addEventListener(CLIENT_UPDATE_REQUIRED_EVENT, onUpdate)
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: 'outdated', code: CLIENT_UPDATE_REQUIRED_CODE }, { status: 426 }),
    { preconnect: originalFetch.preconnect },
  )
  await expect(api.getConversations('token-a')).rejects.toThrow('outdated')
  expect(announced).toBe(1)
  globalThis.removeEventListener(CLIENT_UPDATE_REQUIRED_EVENT, onUpdate)
})
