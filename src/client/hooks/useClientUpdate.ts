import { useEffect, useState } from 'preact/hooks'
import { CLIENT_UPDATE_REQUIRED_EVENT } from '../lib/api'

/** True once the server has rejected this client's delivery protocol. */
export function useClientUpdateRequired(): boolean {
  const [required, setRequired] = useState(false)
  useEffect(() => {
    const update = () => setRequired(true)
    window.addEventListener(CLIENT_UPDATE_REQUIRED_EVENT, update)
    return () => window.removeEventListener(CLIENT_UPDATE_REQUIRED_EVENT, update)
  }, [])
  return required
}

/** Fetch the newest service worker before reloading, so the shell cannot pin old code. */
export async function reloadForUpdate(): Promise<void> {
  try {
    await (await navigator.serviceWorker?.getRegistration())?.update()
  } catch (err) {
    console.error('Service worker update failed:', err)
  }
  window.location.reload()
}
