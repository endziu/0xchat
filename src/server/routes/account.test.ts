import { requireAddress } from '../../shared/address.ts'
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createSession, initDb } from '../db.ts'
import { registrationRemovalLimiter } from '../rate-limiters.ts'
import { noOpSchedule } from '../rate-limit.test-utils.ts'
import { createFetch } from '../router.ts'

const token = 'account-route-token'
const address = requireAddress(`0x${'a'.repeat(40)}`)

function deleteAddress(path: string, ip = '127.0.0.1') {
  return createFetch()(new Request(`http://localhost${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }), { requestIP: () => ({ address: ip }) })
}

describe('registration removal route', () => {
  beforeAll(() => registrationRemovalLimiter.setSchedule(noOpSchedule))
  beforeEach(() => {
    initDb(':memory:')
    createSession(token, address, Date.now() + 60_000)
  })

  test('a malformed address is not found', async () => {
    for (const path of ['/api/addresses/not-an-address', `/api/addresses/${address}/extra`]) {
      const res = await deleteAddress(path)
      expect([path, res.status]).toEqual([path, 404])
    }
  })

  test('rate-limits registration removal per ip', async () => {
    const ip = `registration-removal-${Math.random()}`
    const other = `/api/addresses/0x${'b'.repeat(40)}`
    for (let i = 0; i < 10; i++) expect((await deleteAddress(other, ip)).status).toBe(403)
    const limited = await deleteAddress(other, ip)
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'Too many requests' })
  })
})
