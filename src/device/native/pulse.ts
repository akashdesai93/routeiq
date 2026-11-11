import { removeListener, type RouteIQNativePlugin } from './plugin.ts'

/** A pulse that comes this much early still counts as on time, in milliseconds. */
export const PULSE_SLACK_MS = 150

export interface PulseTimers {
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (id: unknown) => void
}

const BROWSER_TIMERS: PulseTimers = {
  now: Date.now,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
}

/**
 * The live runner's `every(ms, fn)` for the shell.
 *
 * With the phone locked iOS may slow down or hold back a web page's timers,
 * so `setInterval` alone cannot be the drive's clock. Native code is not
 * held back while the location stream is on, and every event it sends wakes
 * the page. So `fn` is called from three places, whichever comes first:
 *
 * 1. every position fix (about one a second from CLLocationManager);
 * 2. the plugin's own 'tick' event, a native one-second timer that keeps
 *    going when fixes stop (a tunnel), so "no GPS for a while" is noticed;
 * 3. the page's setInterval, as in a browser, for when neither arrives.
 *
 * `fn` runs at most once per `ms` (less PULSE_SLACK_MS), whatever the mix,
 * so the session is asked "is anything due?" as often as in a browser.
 */
export function nativeEvery(plugin: RouteIQNativePlugin, timers: PulseTimers = BROWSER_TIMERS): (ms: number, fn: () => void) => () => void {
  return (ms, fn) => {
    let stopped = false
    let last = timers.now()
    const pulse = () => {
      if (stopped) return
      const now = timers.now()
      // A clock that went backwards must not stop the ticks.
      if (now >= last && now - last < ms - PULSE_SLACK_MS) return
      last = now
      fn()
    }
    const fixes = plugin.addListener('fix', pulse)
    const ticks = plugin.addListener('tick', pulse)
    const interval = timers.setInterval(pulse, ms)
    return () => {
      stopped = true
      timers.clearInterval(interval)
      removeListener(fixes)
      removeListener(ticks)
    }
  }
}
