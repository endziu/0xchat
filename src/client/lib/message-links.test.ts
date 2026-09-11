import { describe, expect, test } from 'bun:test'
import { splitMessageLinks } from './message-links'

describe('message links', () => {
  test('finds HTTP and HTTPS URLs without changing surrounding text', () => {
    const message = 'Docs: https://example.com/guide\nand http://localhost:3000/help now'

    const parts = splitMessageLinks(message)

    expect(parts).toEqual([
      { type: 'text', value: 'Docs: ' },
      { type: 'link', value: 'https://example.com/guide' },
      { type: 'text', value: '\nand ' },
      { type: 'link', value: 'http://localhost:3000/help' },
      { type: 'text', value: ' now' },
    ])
    expect(parts.map((part) => part.value).join('')).toBe(message)
  })

  test('leaves sentence punctuation outside links', () => {
    expect(splitMessageLinks('See (https://example.com/a_(b)).')).toEqual([
      { type: 'text', value: 'See (' },
      { type: 'link', value: 'https://example.com/a_(b)' },
      { type: 'text', value: ').' },
    ])
  })

  test('does not turn non-HTTP schemes or embedded HTML into links', () => {
    const message = '<b>hello</b> javascript:alert(1) ftp://example.com'

    expect(splitMessageLinks(message)).toEqual([{ type: 'text', value: message }])
  })

  test('leaves incomplete HTTP URLs as plain text', () => {
    expect(splitMessageLinks('Try https:// later')).toEqual([
      { type: 'text', value: 'Try https:// later' },
    ])
  })
})
