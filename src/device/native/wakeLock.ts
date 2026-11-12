import type { ScreenWakeLock } from '../wakeLock.ts'
import type { RouteIQNativePlugin } from './plugin.ts'

/**
 * Keeps the screen on through the plugin (UIApplication.isIdleTimerDisabled).
 * Unlike the browser's wake lock, iOS does not take it away when the app
 * goes into the background, so there is no "released" to report. The driver
 * can still lock the phone with the side button; the drive goes on.
 */
export function nativeWakeLock(plugin: RouteIQNativePlugin): ScreenWakeLock {
  return {
    acquire: () =>
      plugin.keepAwake({ on: true }).then(
        () => 'held' as const,
        () => 'unavailable' as const,
      ),
    release: () =>
      plugin.keepAwake({ on: false }).then(
        () => {},
        () => {},
      ),
  }
}
