import { useCallback, useRef } from 'preact/hooks'
import { useLatest } from './useLatest'
import { createIdentityTransition, type IdentityTransitionDeps } from '../lib/identity-transition'
import type { Keypair } from '../lib/burner'

/**
 * Wraps createIdentityTransition so the caller only supplies fresh deps and
 * receives a stable import callback. Each dep is stabilized via useLatest
 * (rather than a hand-rolled deps ref), and the transition is created once
 * to keep its latest-attempt guard.
 */
export function useIdentityTransition(deps: IdentityTransitionDeps) {
  const setTransitioning = useLatest(deps.setTransitioning)
  const unsubscribePush = useLatest(deps.unsubscribePush)
  const revokeSession = useLatest(deps.revokeSession)
  const clearSession = useLatest(deps.clearSession)
  const prepareIdentity = useLatest(deps.prepareIdentity)
  const createSession = useLatest(deps.createSession)
  const commit = useLatest(deps.commit)

  const transitionRef = useRef<ReturnType<typeof createIdentityTransition> | null>(null)
  if (!transitionRef.current) {
    transitionRef.current = createIdentityTransition({
      setTransitioning,
      unsubscribePush,
      revokeSession,
      clearSession,
      prepareIdentity,
      createSession,
      commit,
    })
  }

  return useCallback((keypair: Keypair) => transitionRef.current!(keypair), [])
}
