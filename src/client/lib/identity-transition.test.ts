import { requireAddress } from '../../shared/address'
import { describe, expect, test } from 'bun:test'
import { createIdentityTransition, type IdentityTransitionDeps } from './identity-transition'
import type { Keypair } from '../../shared/keypair'

const oldIdentity = { address: requireAddress('0xcba06b5736faf67e54b07b561eae94395e774c51'), privateKey: 'old-private', publicKey: 'old-public' }
const identityB = { address: requireAddress('0xb000000000000000000000000000000000000000'), privateKey: 'b-private', publicKey: 'b-public' }
const identityC = { address: requireAddress('0xc000000000000000000000000000000000000000'), privateKey: 'c-private', publicKey: 'c-public' }

function harness(overrides: Partial<IdentityTransitionDeps> = {}) {
  const events: string[] = []
  const deps: IdentityTransitionDeps = {
    setTransitioning: (value) => { events.push(`transitioning:${value}`) },
    unsubscribePush: async () => { events.push('unsubscribe') },
    revokeSession: async () => { events.push('revoke-session') },
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
      'revoke-session',
      'clear-session',
      'prepare:0xb000000000000000000000000000000000000000',
      'login:0xb000000000000000000000000000000000000000',
      'clear-session',
      'commit:0xb000000000000000000000000000000000000000:token:0xb000000000000000000000000000000000000000',
      'transitioning:false',
    ])
  })

  test('continues safely when push unsubscribe fails', async () => {
    const { events, transition } = harness({
      unsubscribePush: async () => { throw new Error('push unavailable') },
    })

    await transition(identityB)

    expect(events).toContain('clear-session')
    expect(events.slice(-2)).toEqual(['commit:0xb000000000000000000000000000000000000000:token:0xb000000000000000000000000000000000000000', 'transitioning:false'])
  })

  test.each(['registration', 'login'] as const)('keeps the old identity and clears auth when %s fails', async (failure: 'registration' | 'login') => {
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
    const waitForPreparation = async (address: string): Promise<() => void> => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const resolve = resolvers.get(address)
        if (resolve) return resolve
        await Promise.resolve()
      }
      throw new Error(`Preparation did not start for ${address}`)
    }
    const { transition } = harness({
      prepareIdentity: (keypair) => new Promise<void>((resolve) => { resolvers.set(keypair.address, resolve) }),
      commit: (keypair) => { commits.push(keypair.address) },
    })

    const first = transition(identityB)
    const resolveB = await waitForPreparation(requireAddress('0xb000000000000000000000000000000000000000'))
    resolveB()
    await Promise.resolve()
    const second = transition(identityC)
    const resolveC = await waitForPreparation(requireAddress('0xc000000000000000000000000000000000000000'))
    resolveC()
    await Promise.all([first, second])

    expect(commits).toEqual([requireAddress('0xc000000000000000000000000000000000000000')])
  })
})
