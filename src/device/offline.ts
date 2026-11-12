import { useSyncExternalStore } from 'react'

// The offline shell (#9): registers public/sw.js, which keeps the app's own files so the
// app opens with no signal. Never inside the iPhone shell (it ships its files in the app
// and loads exactly what it did before), never on the dev server.

interface OfflineShellOptions {
  /** True inside the iPhone shell (src/device/native). */
  inShell: boolean
  /** True in a production build (import.meta.env.PROD). */
  production: boolean
  /** Where the site is served (import.meta.env.BASE_URL). */
  base: string
}

/**
 * Registers the service worker once the page has loaded. Never throws or rejects: a
 * browser without service workers, or one that refuses (a private window), simply
 * gets no offline shell.
 */
export function startOfflineShell({ inShell, production, base }: OfflineShellOptions): void {
  if (inShell || !production || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  const register = () => {
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        // The files this page loaded before the worker took over (fonts, the map's script).
        // The worker stores only the ones that pass its rules: this site, no query string.
        const urls = performance.getEntriesByType('resource').map((entry) => entry.name)
        registration.active?.postMessage({ type: 'routeiq-store', urls })
      })
      .catch(() => {})
  }
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/** False while the browser says it has no connection. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  )
}
