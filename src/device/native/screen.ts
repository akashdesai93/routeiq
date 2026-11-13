import { pageVisibility, type PageVisibility } from '../visibility.ts'
import { removeListener, type RouteIQNativePlugin } from './plugin.ts'

/**
 * Whether anybody can see the shell's screen: not when the app is in the
 * background (the phone locked, or another app in front), as the plugin's
 * 'appState' event says, nor when the web view itself reports the page
 * hidden. Either one is enough: iOS does not always tell the web view.
 *
 * This is about drawing only. The drive itself (GPS, checks, voice) goes on
 * in the background and is never told (see ALWAYS_IN_FRONT).
 */
export function nativeScreen(plugin: RouteIQNativePlugin, page: PageVisibility = pageVisibility()): PageVisibility {
  let background = false
  const listeners = new Set<(hidden: boolean) => void>()
  const isHidden = () => background || page.isHidden()
  let was = isHidden()
  const changed = () => {
    const now = isHidden()
    if (now === was) return
    was = now
    listeners.forEach((l) => l(now))
  }
  let stopPage: (() => void) | null = null
  let appState: ReturnType<RouteIQNativePlugin['addListener']> | null = null
  const begin = () => {
    stopPage = page.subscribe(changed)
    try {
      appState = plugin.addListener('appState', (change) => {
        // 'inactive' (Control Centre pulled down, a call coming in) still shows the screen.
        if (change?.state === 'background') background = true
        else if (change?.state === 'active') background = false
        else return
        changed()
      })
      void appState.catch(() => {})
    } catch {
      appState = null
    }
  }
  const finish = () => {
    stopPage?.()
    stopPage = null
    if (appState !== null) removeListener(appState)
    appState = null
    background = false
  }
  return {
    isHidden,
    subscribe(listener) {
      if (listeners.size === 0) {
        begin()
        was = isHidden()
      }
      listeners.add(listener)
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return
        finish()
      }
    },
  }
}
