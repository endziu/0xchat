import type { Keypair } from './burner'

export interface IdentityTransitionDeps {
  setTransitioning: (value: boolean) => void
  unsubscribePush: () => Promise<void>
  clearSession: () => void
  prepareIdentity: (keypair: Keypair) => Promise<void>
  createSession: (keypair: Keypair) => Promise<string>
  commit: (keypair: Keypair, token: string) => void
}

export function createIdentityTransition(deps: IdentityTransitionDeps) {
  let latestAttempt = 0

  return async (keypair: Keypair): Promise<void> => {
    const attempt = ++latestAttempt
    deps.setTransitioning(true)

    try {
      try {
        await deps.unsubscribePush()
      } catch {
        // Losing a browser/provider subscription must not retain old auth.
      }
      if (attempt !== latestAttempt) return

      deps.clearSession()
      await deps.prepareIdentity(keypair)
      if (attempt !== latestAttempt) return

      const token = await deps.createSession(keypair)
      if (attempt !== latestAttempt) return

      // Invalidate any old-identity login that completed during preparation.
      deps.clearSession()
      deps.commit(keypair, token)
    } catch (error) {
      if (attempt === latestAttempt) deps.clearSession()
      throw error
    } finally {
      if (attempt === latestAttempt) deps.setTransitioning(false)
    }
  }
}
