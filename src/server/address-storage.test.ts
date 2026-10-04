import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireAddress } from '../shared/address'
import { initDb, getDb, getSession, getPubkey, getPushSubscriptionsForAddress, createSession, deleteRegistration } from './db'

test('database upgrade preserves legacy registration and session associations', () => {
  const dir = mkdtempSync(join(tmpdir(), '0xchat-address-'))
  const path = join(dir, 'chat.db')
  const legacy = '0x52908400098527886E0F7030069857D2E4169EE7'
  const address = requireAddress(legacy)
  try {
    initDb(path)
    createSession('token', address, Date.now() + 60_000)
    getDb().query('UPDATE sessions SET address = ?').run(legacy)
    getDb().query('INSERT INTO pubkeys VALUES (?, ?, ?)').run(legacy, 'pubkey', Date.now())
    getDb().query('INSERT INTO push_subscriptions VALUES (?, ?, ?, ?, ?)').run('endpoint', legacy, 'key', 'auth', Date.now())
    getDb().close()
    initDb(path)
    expect(getSession('token')?.address).toBe(address)
    expect(getPubkey(address)).toBe('pubkey')
    expect(getPushSubscriptionsForAddress(address)).toHaveLength(1)
    deleteRegistration(address)
    expect(getSession('token')).toBeNull()
    expect(getPushSubscriptionsForAddress(address)).toHaveLength(0)
  } finally {
    getDb().close()
    rmSync(dir, { recursive: true, force: true })
  }
})
