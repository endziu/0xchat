import { useCallback, useRef } from 'preact/hooks'
import { createIdentityTransition, type IdentityTransitionDeps } from '../lib/identity-transition'
import type { Keypair } from '../lib/burner'

/**
 * Wraps createIdentityTransition so the caller only supplies fresh deps and
 * receives a stable import callback. The transition is created once (keeping
 * the latest-attempt guard) but always invokes the latest deps.
 */
export function useIdentityTransition(deps: IdentityTransitionDeps) {
  const depsRef = useRef(deps)
  depsRef.current = deps

  const transitionRef = useRef<ReturnType<typeof createIdentityTransition> | null>(null)
  if (!transitionRef.current) {
    transitionRef.current = createIdentityTransition({
      setTransitioning: (value) => depsRef.current.setTransitioning(value),
      unsubscribePush: () => depsRef.current.unsubscribePush(),
      clearSession: () => depsRef.current.clearSession(),
      prepareIdentity: (keypair) => depsRef.current.prepareIdentity(keypair),
      createSession: (keypair) => depsRef.current.createSession(keypair),
      commit: (keypair, token) => depsRef.current.commit(keypair, token),
    })
  }

  return useCallback((keypair: Keypair) => transitionRef.current!(keypair), [])
}
