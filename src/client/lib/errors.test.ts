import { describe, it, expect } from 'bun:test'
import { errorMessage } from './errors'

describe('errorMessage', () => {
  it('uses the message of a real Error', () => {
    expect(errorMessage(new Error('Unauthorized'), 'fallback')).toBe('Unauthorized')
  })

  it('uses a thrown string', () => {
    expect(errorMessage('Network down', 'fallback')).toBe('Network down')
  })

  it('falls back for a non-Error throw', () => {
    expect(errorMessage({ status: 500 }, 'fallback')).toBe('fallback')
    expect(errorMessage(null, 'fallback')).toBe('fallback')
    expect(errorMessage(undefined, 'fallback')).toBe('fallback')
  })

  it('falls back for an Error with a blank message', () => {
    expect(errorMessage(new Error(''), 'fallback')).toBe('fallback')
    expect(errorMessage(new Error('   '), 'fallback')).toBe('fallback')
  })
})
