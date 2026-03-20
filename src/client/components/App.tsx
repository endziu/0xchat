import { useState, useEffect } from 'preact/hooks'
import { useIdentity } from '../hooks/useIdentity'
import { useSession } from '../hooks/useSession'
import { Layout } from './Layout'
import { OnboardingView } from './OnboardingView'
import { ChatView } from './ChatView'

export function App() {
  const { identity, isRegistered, loading: idLoading, register, logout: idLogout, importIdentity } = useIdentity()
  const { token, loading: sessionLoading, login } = useSession(identity)
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

  const navigate = (to: string) => {
    window.history.pushState({}, '', to)
    setPath(to)
  }

  if (idLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-accent animate-pulse font-serif italic text-2xl">Initializing identity...</div>
      </div>
    )
  }

  if (!isRegistered) {
    return (
      <Layout identity={identity} token={token} onLogout={idLogout}>
        <OnboardingView onRegister={register} />
      </Layout>
    )
  }

  if (!token) {
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
      token={token} 
      onLogout={idLogout} 
      onImport={importIdentity}
      navigate={navigate}
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
