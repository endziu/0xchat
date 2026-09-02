import { describe, expect, test } from 'bun:test'
import { SECURITY_HEADERS } from '../server/constants'

interface StartupWindow {
  location: { hash: string; pathname: string; search: string }
  history: {
    state: unknown
    replaceState: (state: unknown, title: string, url: string) => void
  }
  localStorage: Storage
}

async function runFragmentGuard(window: StartupWindow): Promise<void> {
  const html = await Bun.file(new URL('../../index.html', import.meta.url)).text()
  const script = html.match(/<script data-clear-fragment>([\s\S]*?)<\/script>/)?.[1]
  expect(script).toBeDefined()
  Function('window', script!)(window)
}

describe('URL fragment guard', () => {
  test.each([
    '#0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    '#not-a-private-key',
    '#unrelated',
  ])('clears %s before application startup without touching identity storage', async (hash: string) => {
    const existingIdentity = 'existing-private-key'
    let replacement: { state: unknown; url: string } | undefined
    const window: StartupWindow = {
      location: { hash, pathname: '/chat/0xabc', search: '?source=test' },
      history: {
        state: { navigation: 1 },
        replaceState(state, _title, url) { replacement = { state, url } },
      },
      localStorage: {
        getItem: () => existingIdentity,
        setItem: () => { throw new Error('identity storage touched') },
      } as unknown as Storage,
    }

    await runFragmentGuard(window)

    expect(replacement).toEqual({ state: window.history.state, url: '/chat/0xabc?source=test' })
    expect(window.localStorage.getItem('0xchat_burner_v1')).toBe(existingIdentity)
  })

  test('is permitted by the application content security policy', async () => {
    const html = await Bun.file(new URL('../../index.html', import.meta.url)).text()
    const script = html.match(/<script data-clear-fragment>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeDefined()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script!))
    const source = `'sha256-${Buffer.from(digest).toString('base64')}'`

    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain(source)
  })

  test('leaves fragment-free URLs alone', async () => {
    let replacements = 0
    const window: StartupWindow = {
      location: { hash: '', pathname: '/chat', search: '' },
      history: {
        state: null,
        replaceState: () => { replacements++ },
      },
      localStorage: {} as Storage,
    }

    await runFragmentGuard(window)

    expect(replacements).toBe(0)
  })
})
