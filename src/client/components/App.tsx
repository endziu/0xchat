import { useState, useEffect } from 'preact/hooks'
import { useIdentity } from '../hooks/useIdentity'
import { useSession } from '../hooks/useSession'
import { Layout } from './Layout'
import { OnboardingView } from './OnboardingView'
import { ChatView } from './ChatView'

export function App() {
  const { identity, isRegistered, loading: idLoading, error: idError, register, logout: idLogout, importIdentity } = useIdentity()
  const { token, loading: sessionLoading, error: loginError, login, logout: sessionLogout } = useSession(identity)
  const [path, setPath] = useState(window.location.pathname)

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname)
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  // Auto-login when registered but no token
  useEffect(() => {
    if (identity && isRegistered && !token && !sessionLoading) {
      login()
    }
  }, [identity, isRegistered, token, sessionLoading, login])

  // Handle session expiry: re-authenticate instead of destroying identity
  useEffect(() => {
    const handleAuthExpired = () => {
      sessionLogout()
    }
    window.addEventListener('auth:expired', handleAuthExpired)
    return () => window.removeEventListener('auth:expired', handleAuthExpired)
  }, [sessionLogout])

  const navigate = (to: string) => {
    window.history.pushState({}, '', to)
    setPath(to)
  }

  if (idLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        {idError ? (
          <div className="flex flex-col items-center gap-4 max-w-sm">
            <p className="text-error font-mono text-sm text-center">{idError}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-8 py-3 border border-accent text-accent hover:bg-accent hover:text-bg transition-colors uppercase tracking-widest font-bold cursor-pointer"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="text-accent animate-pulse font-serif italic text-2xl">Initializing identity...</div>
        )}
      </div>
    )
  }

  if (!isRegistered) {
    return (
      <Layout identity={identity} onLogout={idLogout}>
        {idError && (
          <div className="mb-4 p-4 bg-error/20 border border-error/50 rounded text-error text-sm">
            {idError}
          </div>
        )}
        <OnboardingView onRegister={register} />
      </Layout>
    )
  }

  if (!token) {
    if (loginError) {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <div className="flex flex-col items-center gap-6 max-w-sm">
            <p className="text-error font-mono text-sm text-center">{loginError}</p>
            <button
              onClick={login}
              disabled={sessionLoading}
              className="px-8 py-3 border border-accent text-accent hover:bg-accent hover:text-bg transition-colors disabled:opacity-50 uppercase tracking-widest font-bold cursor-pointer"
            >
              {sessionLoading ? 'Retrying...' : 'Retry'}
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-accent animate-pulse font-serif italic text-2xl">Connecting...</div>
      </div>
    )
  }

  const chatAddress = path.startsWith('/chat/') ? path.slice(6) : null

  return (
    <Layout
      identity={identity}
      onLogout={idLogout}
      onImport={importIdentity}
      navigate={navigate}
      error={idError}
    >
      <ChatView
        recipientAddress={chatAddress}
        identity={identity!}
        token={token}
        navigate={navigate}
      />
    </Layout>
  )
}
