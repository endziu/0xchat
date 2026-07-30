import { render } from 'preact'
import { App } from './components/App'
import './styles.css'

render(<App />, document.getElementById('app')!)

// App-shell caching + the "Install" affordance. Dev is served by Vite, where a
// stale shell cache would shadow HMR, so only register on the built app.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.error('SW registration failed:', err))
  })
}
