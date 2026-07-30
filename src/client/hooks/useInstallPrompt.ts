import { useState, useEffect, useCallback } from 'preact/hooks'

const DISMISSED_KEY = 'eth_chat_install_dismissed_v1'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallMode =
  | null      // already installed, dismissed, or not installable here
  | 'prompt'  // Chromium — we hold a deferred beforeinstallprompt
  | 'ios'     // iOS Safari — no API, the user has to use the Share sheet

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as any).standalone === true

const isIosSafari = () => {
  const ua = navigator.userAgent
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  // Chrome/Firefox on iOS can't install to the home screen at all.
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
}

/**
 * Surfaces "add to home screen" where the browser supports it. Chromium fires
 * `beforeinstallprompt` which we defer until the user asks; iOS Safari has no
 * such API, so there we can only tell them where the button is.
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [mode, setMode] = useState<InstallMode>(null)

  useEffect(() => {
    if (isStandalone() || localStorage.getItem(DISMISSED_KEY)) return

    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
      setMode('prompt')
    }
    const onInstalled = () => { setMode(null); setDeferred(null) }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)

    if (isIosSafari()) setMode('ios')

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const install = useCallback(async () => {
    if (!deferred) return
    await deferred.prompt()
    const { outcome } = await deferred.userChoice
    setDeferred(null)
    if (outcome === 'accepted') setMode(null)
  }, [deferred])

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()))
    setMode(null)
  }, [])

  return { mode, install, dismiss }
}
