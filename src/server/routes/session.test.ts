import { beforeEach, describe, expect, test } from 'bun:test'
import { createSession, initDb } from '../db.ts'
import { createFetch } from '../router.ts'

const token = 'session-route-token'
const address = `0x${'a'.repeat(40)}`
const server = { requestIP: () => ({ address: '127.0.0.1' }) }

describe('session route', () => {
  beforeEach(() => {
    initDb(':memory:')
    createSession(token, address, Date.now() + 60_000)
  })

  test('DELETE /api/session revokes the bearer token', async () => {
    const fetch = createFetch()
    const revoked = await fetch(new Request('http://localhost/api/session', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }), server)

    expect(revoked.status).toBe(204)

    const rejected = await fetch(new Request('http://localhost/api/conversations', {
      headers: { Authorization: `Bearer ${token}` },
    }), server)

    expect(rejected.status).toBe(401)
  })
})
