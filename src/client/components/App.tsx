import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { useIdentity } from '../hooks/useIdentity'
import { useSession } from '../hooks/useSession'
import { usePushSubscription } from '../hooks/usePushSubscription'
import { createIdentityTransition, type IdentityTransitionDeps } from '../lib/identity-transition'
import type { Keypair } from '../lib/burner'
import { Layout } from './Layout'
import { ChatView } from './ChatView'
import { ToastProvider } from './Toast'

function AppContent() {
  const { identity, isRegistered, loading: idLoading, error: idError, logout: idLogout, prepareIdentity, commitIdentity } = useIdentity()
  const { token, loading: sessionLoading, error: loginError, login, logout: sessionLogout, createSession, commitSession } = useSession(identity)
  const push = usePushSubscription(token)
  const [path, setPath] = useState(window.location.pathname)
  const [sseConnected, setSseConnected] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  const transitionDeps = useRef<IdentityTransitionDeps>(null!)
  transitionDeps.current = {
    setTransitioning,
    unsubscribePush: push.unsubscribe,
    clearSession: sessionLogout,
    prepareIdentity,
    createSession,
    commit: (keypair, newToken) => {
      commitIdentity(keypair)
      commitSession(keypair.address, newToken)
    },
  }
  const transition = useRef<ReturnType<typeof createIdentityTransition> | null>(null)
  if (!transition.current) {
    transition.current = createIdentityTransition({
      setTransitioning: (value) => transitionDeps.current.setTransitioning(value),
      unsubscribePush: () => transitionDeps.current.unsubscribePush(),
      clearSession: () => transitionDeps.current.clearSession(),
      prepareIdentity: (keypair) => transitionDeps.current.prepareIdentity(keypair),
      createSession: (keypair) => transitionDeps.current.createSession(keypair),
      commit: (keypair, newToken) => transitionDeps.current.commit(keypair, newToken),
    })
  }

  const importIdentity = useCallback((keypair: Keypair) => transition.current!(keypair), [])

  const handleLogout = async () => {
    await push.unsubscribe()
    idLogout()
  }

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname)
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (identity && isRegistered && !token && !sessionLoading && !transitioning) login()
  }, [identity, isRegistered, token, sessionLoading, transitioning, login])

  useEffect(() => {
    const handleAuthExpired = () => sessionLogout()
    window.addEventListener('auth:expired', handleAuthExpired)
    return () => window.removeEventListener('auth:expired', handleAuthExpired)
  }, [sessionLogout])

  const navigate = useCallback((to: string) => {
    window.history.pushState({}, '', to)
    setPath(to)
  }, [])

  if (idLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-dvh gap-2">
        {idError ? (
          <>
            <p className="text-red-400">{idError}</p>
            <button onClick={() => window.location.reload()}>Retry</button>
          </>
        ) : (
          <span className="text-neutral-600">Initializing...</span>
        )}
      </div>
    )
  }

  if (transitioning) {
    return <div className="flex items-center justify-center h-dvh text-neutral-600">Switching identity...</div>
  }

  if (!token) {
    if (loginError) {
      return (
        <div className="flex flex-col items-center justify-center h-dvh gap-2">
          <p className="text-red-400">{loginError}</p>
          <button onClick={login} disabled={sessionLoading}>{sessionLoading ? 'Retrying...' : 'Retry'}</button>
        </div>
      )
    }
    return <div className="flex items-center justify-center h-dvh text-neutral-600">Connecting...</div>
  }

  return (
    <Layout
      identity={identity}
      onLogout={handleLogout}
      onImport={importIdentity}
      navigate={navigate}
      error={idError}
      sseConnected={sseConnected}
      pushSupported={push.supported}
      pushSubscribed={push.subscribed}
      pushPermission={push.permission}
      pushError={push.error}
      onPushSubscribe={push.subscribe}
      onPushUnsubscribe={push.unsubscribe}
    >
      <ChatView
        recipientAddress={path.startsWith('/chat/') ? path.slice(6) : null}
        identity={identity!}
        token={token}
        navigate={navigate}
        onConnectedChange={setSseConnected}
      />
    </Layout>
  )
}

export function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  )
}
