import { describe, expect, test } from 'bun:test'
import { requestPushPermission } from './push-permission'

describe('requestPushPermission', () => {
  test('reports granted when current and permission is granted', async () => {
    let prompted = 0
    const result = await requestPushPermission({
      requestPermission: async () => { prompted++; return 'granted' },
      isStale: () => false,
    })
    expect(prompted).toBe(1)
    expect(result).toEqual({ superseded: false, granted: true, permission: 'granted' })
  })

  test('reports not-granted when current and permission is denied', async () => {
    const result = await requestPushPermission({
      requestPermission: async () => 'denied',
      isStale: () => false,
    })
    expect(result).toEqual({ superseded: false, granted: false, permission: 'denied' })
  })

  test('does not prompt when superseded at entry', async () => {
    let prompted = 0
    const result = await requestPushPermission({
      requestPermission: async () => { prompted++; return 'granted' },
      isStale: () => true,
    })
    expect(prompted).toBe(0)
    expect(result).toEqual({ superseded: true, granted: false, permission: null })
  })

  test('discards the result when superseded during the prompt', async () => {
    let stale = false
    const result = await requestPushPermission({
      requestPermission: async () => { stale = true; return 'denied' },
      isStale: () => stale,
    })
    // Prompted, but superseded before completion: callers must not apply it.
    expect(result).toEqual({ superseded: true, granted: false, permission: 'denied' })
  })
})
