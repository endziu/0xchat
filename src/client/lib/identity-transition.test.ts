import { describe, expect, test } from 'bun:test'
import { createIdentityTransition, type IdentityTransitionDeps } from './identity-transition'
import type { Keypair } from './burner'

const oldIdentity = { address: '0xold', privateKey: 'old-private', publicKey: 'old-public' }
const identityB = { address: '0xb', privateKey: 'b-private', publicKey: 'b-public' }
const identityC = { address: '0xc', privateKey: 'c-private', publicKey: 'c-public' }

function harness(overrides: Partial<IdentityTransitionDeps> = {}) {
  const events: string[] = []
  const deps: IdentityTransitionDeps = {
    setTransitioning: (value) => { events.push(`transitioning:${value}`) },
    unsubscribePush: async () => { events.push('unsubscribe') },
    clearSession: () => { events.push('clear-session') },
    prepareIdentity: async (keypair) => { events.push(`prepare:${keypair.address}`) },
    createSession: async (keypair) => { events.push(`login:${keypair.address}`); return `token:${keypair.address}` },
    commit: (keypair, token) => { events.push(`commit:${keypair.address}:${token}`) },
    ...overrides,
  }
  return { events, transition: createIdentityTransition(deps) }
}

describe('identity transition', () => {
  test('stops old push and session before registering, logging in, and committing the new identity', async () => {
    const { events, transition } = harness()

    await transition(identityB)

    expect(events).toEqual([
      'transitioning:true',
      'unsubscribe',
      'clear-session',
      'prepare:0xb',
      'login:0xb',
      'clear-session',
      'commit:0xb:token:0xb',
      'transitioning:false',
    ])
  })

  test('continues safely when push unsubscribe fails', async () => {
    const { events, transition } = harness({
      unsubscribePush: async () => { throw new Error('push unavailable') },
    })

    await transition(identityB)

    expect(events).toContain('clear-session')
    expect(events).toContain('commit:0xb:token:0xb')
  })

  test.each(['registration', 'login'] as const)('keeps the old identity and clears auth when %s fails', async (failure) => {
    let active: Keypair = oldIdentity
    const { events, transition } = harness({
      prepareIdentity: async () => { if (failure === 'registration') throw new Error('registration failed') },
      createSession: async () => {
        if (failure === 'login') throw new Error('login failed')
        return 'token-b'
      },
      commit: (keypair) => { active = keypair },
    })

    await expect(transition(identityB)).rejects.toThrow(`${failure} failed`)

    expect(active).toBe(oldIdentity)
    expect(events.at(-2)).toBe('clear-session')
    expect(events.at(-1)).toBe('transitioning:false')
  })

  test('only the latest rapid import can become active', async () => {
    const resolvers = new Map<string, () => void>()
    const commits: string[] = []
    const { transition } = harness({
      prepareIdentity: (keypair) => new Promise<void>((resolve) => { resolvers.set(keypair.address, resolve) }),
      commit: (keypair) => { commits.push(keypair.address) },
    })

    const first = transition(identityB)
    await Promise.resolve()
    resolvers.get('0xb')?.()
    await Promise.resolve()
    const second = transition(identityC)
    await Promise.resolve()
    resolvers.get('0xc')?.()
    await Promise.all([first, second])

    expect(commits).toEqual(['0xc'])
  })
})
