import { useState, useEffect, useCallback } from 'preact/hooks'
import { useIdentity } from '../hooks/useIdentity'
import { useSession } from '../hooks/useSession'
import { deriveKeypair } from '../lib/burner'
import { Layout } from './Layout'
import { ChatView } from './ChatView'
import { ToastProvider } from './Toast'

function AppContent() {
  const { identity, isRegistered, loading: idLoading, error: idError, logout: idLogout, importIdentity } = useIdentity()
  const { token, loading: sessionLoading, error: loginError, login, logout: sessionLogout } = useSession(identity)
  const [path, setPath] = useState(window.location.pathname)
  const [sseConnected, setSseConnected] = useState(false)

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname)
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (identity && isRegistered && !token && !sessionLoading) login()
  }, [identity, isRegistered, token, sessionLoading, login])

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

  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (!hash) return
    const hex = hash.startsWith('0x') ? hash : `0x${hash}`
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) { window.location.hash = ''; return }
    (async () => {
      try {
        await importIdentity(deriveKeypair(hex))
        window.location.hash = ''
        navigate('/chat')
      } catch (err) {
        console.error('Failed to import key from hash:', err)
        window.location.hash = ''
      }
    })()
  }, [navigate, importIdentity])

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
    <Layout identity={identity} onLogout={idLogout} onImport={importIdentity} navigate={navigate} error={idError} sseConnected={sseConnected}>
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
