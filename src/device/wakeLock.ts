/** A held lock, as the Screen Wake Lock API hands it out. */
export interface WakeLockSentinelLike {
  release(): Promise<void>
  addEventListener?(type: 'release', listener: () => void): void
}

/** The part of navigator.wakeLock that is used, so a test can hand in a stand-in. */
export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>
}

/** 'held': the screen stays on. 'unavailable': this browser has no wake lock, or refused (battery saver, page hidden). */
export type WakeLockResult = 'held' | 'unavailable'

/** Keeps the screen on during a live drive. A native shell replaces it (UIApplication.isIdleTimerDisabled). */
export interface ScreenWakeLock {
  /** Asks for the lock. Safe to call again while held, and again after the system released it. Never rejects. */
  acquire(): Promise<WakeLockResult>
  /** Gives the lock back. Never rejects. */
  release(): Promise<void>
}

export interface WakeLockOptions {
  /** The Wake Lock implementation; null for "this browser has none". Defaults to the browser's. */
  wakeLock?: WakeLockLike | null
  /** Called when the system takes the lock away by itself (the page went into the background). */
  onReleased?: () => void
}

function defaultWakeLock(): WakeLockLike | null {
  try {
    return (globalThis.navigator as { wakeLock?: WakeLockLike } | undefined)?.wakeLock ?? null
  } catch {
    return null
  }
}

/**
 * The Screen Wake Lock API behind three small promises that never reject.
 * The browser drops the lock whenever the page is hidden; the live session
 * asks for it again when the page is back in front (see core/live.ts).
 */
export function createWakeLock(options: WakeLockOptions = {}): ScreenWakeLock {
  const { wakeLock = defaultWakeLock(), onReleased } = options
  let held: WakeLockSentinelLike | null = null
  let wanted = false
  return {
    async acquire() {
      wanted = true
      if (wakeLock === null) return 'unavailable'
      if (held !== null) return 'held'
      try {
        const sentinel = await wakeLock.request('screen')
        if (!wanted) {
          // Released while the request was out.
          await sentinel.release().catch(() => {})
          return 'unavailable'
        }
        held = sentinel
        sentinel.addEventListener?.('release', () => {
          if (held !== sentinel) return
          held = null
          if (wanted) onReleased?.()
        })
        return 'held'
      } catch {
        return 'unavailable'
      }
    },
    async release() {
      wanted = false
      const sentinel = held
      held = null
      if (sentinel !== null) await sentinel.release().catch(() => {})
    },
  }
}
