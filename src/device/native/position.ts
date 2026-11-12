import { isValidLngLat } from '../../core/index.ts'
import type { GeolocationLike, LocationErrorKind, PositionSource } from '../geolocation.ts'
import { removeListener, type NativeFix, type RouteIQNativePlugin } from './plugin.ts'

const finiteOrNull = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

const kindOf = (kind: unknown): LocationErrorKind => (kind === 'denied' ? 'denied' : kind === 'timeout' ? 'timeout' : 'unavailable')

const validFix = (fix: NativeFix | null | undefined): fix is NativeFix =>
  fix !== undefined && fix !== null && typeof fix.lng === 'number' && typeof fix.lat === 'number' && isValidLngLat([fix.lng, fix.lat])

/**
 * The phone's GPS through the shell's plugin (CLLocationManager with
 * background updates), in place of the browser's watchPosition: it keeps
 * coming while the phone is locked or another app is in front. Like the
 * browser source, each fix is stamped with this clock on arrival, handed
 * over and kept nowhere; nothing is logged.
 */
export function nativePositionSource(plugin: RouteIQNativePlugin, now: () => number = Date.now): PositionSource {
  return {
    start(onFix, onError) {
      let stopped = false
      const fixes = plugin.addListener('fix', (fix) => {
        if (stopped) return
        if (!validFix(fix)) {
          onError('unavailable')
          return
        }
        onFix({
          lng: fix.lng,
          lat: fix.lat,
          accuracyM: finiteOrNull(fix.accuracy) ?? NaN,
          speedMps: finiteOrNull(fix.speed),
          headingDeg: finiteOrNull(fix.course),
          timeMs: now(),
        })
      })
      const errors = plugin.addListener('locationError', (error) => {
        if (!stopped) onError(kindOf(error?.kind))
      })
      plugin.startLocation().catch((error: { code?: unknown } | undefined) => {
        if (!stopped) onError(kindOf(error?.code))
      })
      return () => {
        if (stopped) return
        stopped = true
        removeListener(fixes)
        removeListener(errors)
        plugin.stopLocation().catch(() => {})
      }
    },
  }
}

/**
 * The plugin's one-shot position behind the browser's getCurrentPosition
 * shape, for "Use my location" (currentPosition in ../geolocation.ts takes
 * it as its `geolocation`). The time limit is kept here, on a web timer:
 * this is only used with the app in front.
 */
export function nativeGeolocation(plugin: RouteIQNativePlugin): GeolocationLike {
  return {
    getCurrentPosition(success, error, options) {
      let done = false
      const timer =
        options?.timeout === undefined
          ? null
          : setTimeout(() => {
              if (done) return
              done = true
              error?.({ code: 3 })
            }, options.timeout)
      const finish = (answer: () => void) => {
        if (done) return
        done = true
        if (timer !== null) clearTimeout(timer)
        answer()
      }
      plugin.getCurrentPosition().then(
        (fix) =>
          finish(() =>
            validFix(fix) ? success({ coords: { longitude: fix.lng, latitude: fix.lat, accuracy: fix.accuracy } }) : error?.({ code: 2 }),
          ),
        (failure: { code?: unknown } | undefined) =>
          finish(() => error?.({ code: failure?.code === 'denied' ? 1 : failure?.code === 'timeout' ? 3 : 2 })),
      )
    },
  }
}
