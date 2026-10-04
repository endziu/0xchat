import { requireAddress } from '../../shared/address'
import { expect, test } from 'bun:test'
import { displayName, fmtDay, fmtRemaining, shortAddr } from './display'

const alice = requireAddress(`0xb9bb${'0'.repeat(32)}574b`)
const me = requireAddress(`0x32bd${'0'.repeat(32)}8b54`)

test('displayName prefers You, then the label, then the short address', () => {
  expect(displayName(me, {}, me)).toBe('You')
  expect(displayName(alice, { [alice]: 'Alice' }, me)).toBe('Alice')
  expect(displayName(alice, {}, me)).toBe(shortAddr(alice))
  expect(shortAddr(alice)).toBe('0xb9bb…574B')
})

test('fmtRemaining uses the largest whole unit', () => {
  const now = 1_000_000
  expect(fmtRemaining(now + 12_000, now)).toBe('12s')
  expect(fmtRemaining(now + 400, now)).toBe('1s')
  expect(fmtRemaining(now - 5_000, now)).toBe('0s')
  expect(fmtRemaining(now + 29 * 60_000 + 30_000, now)).toBe('29m')
  expect(fmtRemaining(now + 4 * 3_600_000 + 59 * 60_000, now)).toBe('4h')
})

test('fmtDay names only days before today', () => {
  const now = new Date(2026, 8, 29, 0, 30).getTime()
  expect(fmtDay(new Date(2026, 8, 29, 0, 5).getTime(), now)).toBeNull()
  expect(fmtDay(new Date(2026, 8, 28, 23, 39).getTime(), now)).toBe('Yesterday')
  expect(fmtDay(new Date(2026, 8, 27, 12).getTime(), now)).not.toBeNull()
})
