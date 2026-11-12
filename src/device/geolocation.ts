import { isValidLngLat, type LngLat, type PositionFix } from '../core/index.ts'
import { sessionNow } from './clock.ts'

export type LocationErrorKind =
  /** The user, or the browser's settings, said no. */
  | 'denied'
  /** The device could not work out where it is. */
  | 'unavailable'
  | 'timeout'
  /** The page is not on HTTPS or localhost, where browsers refuse to locate. */
  | 'insecure'
  /** This browser has no Geolocation API. */
  | 'unsupported'

export type LocationResult =
  | { readonly ok: true; readonly position: LngLat; /** Radius of the fix in meters; null when not given. */ readonly accuracyM: number | null }
  | { readonly ok: false; readonly kind: LocationErrorKind; readonly message: string }

/** How long one fix may take. */
export const LOCATION_TIMEOUT_MS = 15_000

const MESSAGES: Readonly<Record<LocationErrorKind, string>> = {
  denied:
    'Location permission was denied. Allow location for this site in the browser settings, or search for a starting point instead.',
  unavailable: 'Your location could not be determined right now. Try again, or search for a starting point.',
  timeout: 'Finding your location took too long. Try again, or search for a starting point.',
  insecure: 'Browsers only share location on secure pages (HTTPS or localhost). Search for a starting point instead.',
  unsupported: 'This browser cannot share its location. Search for a starting point instead.',
}

function fail(kind: LocationErrorKind): LocationResult {
  return { ok: false, kind, message: MESSAGES[kind] }
}

/** The coordinates of a browser position, as far as they are read here. */
export interface CoordsLike {
  longitude: number
  latitude: number
  accuracy?: number
  /** Meters per second; null or NaN when the device does not know. */
  speed?: number | null
  /** Degrees clockwise from true north; null or NaN when the device does not know (standing still). */
  heading?: number | null
}

/** The methods of the browser's Geolocation API that are used, so a test can hand in a stand-in. */
export interface GeolocationLike {
  getCurrentPosition(
    success: (position: { coords: CoordsLike }) => void,
    error?: (error: { code: number }) => void,
    options?: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  ): void
  /** Left out by a stand-in that only answers once: watching is then "unsupported". */
  watchPosition?(
    success: (position: { coords: CoordsLike }) => void,
    error?: (error: { code: number }) => void,
    options?: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  ): number
  clearWatch?(id: number): void
}

export interface CurrentPositionOptions {
  /** The Geolocation implementation; null for "this browser has none". Defaults to the browser's. */
  geolocation?: GeolocationLike | null
  /** Whether the page is a secure context. Defaults to the browser's own answer. */
  secureContext?: boolean
  timeoutMs?: number
}

function defaultGeolocation(): GeolocationLike | null {
  try {
    return globalThis.navigator?.geolocation ?? null
  } catch {
    return null
  }
}

/**
 * Asks the device where it is, once (no watching), with high accuracy and a
 * time limit. Never rejects, and never runs by itself: the app calls it only
 * when the user presses "Use my location". The browser's numeric error codes
 * (1 denied, 2 unavailable, 3 timeout) become kinds with a message fit to
 * show. The position is returned to the caller and kept nowhere here.
 */
export function currentPosition(options: CurrentPositionOptions = {}): Promise<LocationResult> {
  const {
    geolocation = defaultGeolocation(),
    secureContext = globalThis.isSecureContext ?? true,
    timeoutMs = LOCATION_TIMEOUT_MS,
  } = options
  // Checked first: on an insecure page some browsers hide the API, others answer "denied".
  if (!secureContext) return Promise.resolve(fail('insecure'))
  if (geolocation === null) return Promise.resolve(fail('unsupported'))
  return new Promise((resolve) => {
    try {
      geolocation.getCurrentPosition(
        ({ coords }) => {
          const position: LngLat = [coords.longitude, coords.latitude]
          if (typeof coords.longitude !== 'number' || typeof coords.latitude !== 'number' || !isValidLngLat(position)) {
            resolve(fail('unavailable'))
            return
          }
          const accuracy = coords.accuracy
          resolve({
            ok: true,
            position,
            accuracyM: typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
          })
        },
        (error) => resolve(fail(error.code === 1 ? 'denied' : error.code === 3 ? 'timeout' : 'unavailable')),
        // maximumAge 0: a fresh fix, not one the browser kept from earlier.
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
      )
    } catch {
      resolve(fail('unavailable'))
    }
  })
}

/**
 * Where a live drive gets its positions from. The browser's GPS is one
 * (geolocationSource); the development replay is another; a native shell
 * brings its own. `start` begins a stream of fixes and errors and returns
 * the function that ends it; it never throws.
 */
export interface PositionSource {
  start(onFix: (fix: PositionFix) => void, onError: (kind: LocationErrorKind) => void): () => void
  /**
   * Told which route is being driven whenever that changes. The device's
   * GPS has no use for it; a simulated driver follows it.
   */
  follow?(geometry: readonly LngLat[]): void
}

/** How long the device may take over one fix of a watch before it reports a timeout (and keeps trying). */
export const WATCH_TIMEOUT_MS = 20_000

export interface WatchOptions extends Omit<CurrentPositionOptions, 'timeoutMs'> {
  timeoutMs?: number
  /** The clock every fix is stamped with on arrival. Defaults to the session clock (clock.ts), which never steps back. */
  now?: () => number
}

const finiteOrNull = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/**
 * The device's position as a stream: the browser's `watchPosition`, with
 * high accuracy and no cached fixes. Asks for the location permission when
 * started, so it is started only from the "Start drive" tap. Each fix is
 * handed over as it comes and kept nowhere here; nothing is logged. A fix is
 * stamped with this clock's time on arrival, so that fix times and the
 * session's own clock can be compared. Errors come as kinds (the same as
 * currentPosition's); the watch itself goes on after an error until stopped.
 */
export function geolocationSource(options: WatchOptions = {}): PositionSource {
  const {
    geolocation = defaultGeolocation(),
    secureContext = globalThis.isSecureContext ?? true,
    timeoutMs = WATCH_TIMEOUT_MS,
    now = sessionNow,
  } = options
  return {
    start(onFix, onError) {
      if (!secureContext) {
        onError('insecure')
        return () => {}
      }
      if (geolocation === null || geolocation.watchPosition === undefined) {
        onError('unsupported')
        return () => {}
      }
      let id: number | null = null
      let stopped = false
      try {
        id = geolocation.watchPosition(
          ({ coords }) => {
            if (stopped) return
            if (typeof coords.longitude !== 'number' || typeof coords.latitude !== 'number' || !isValidLngLat([coords.longitude, coords.latitude])) {
              onError('unavailable')
              return
            }
            onFix({
              lng: coords.longitude,
              lat: coords.latitude,
              accuracyM: finiteOrNull(coords.accuracy) ?? NaN,
              speedMps: finiteOrNull(coords.speed),
              headingDeg: finiteOrNull(coords.heading),
              timeMs: now(),
            })
          },
          (error) => {
            if (!stopped) onError(error.code === 1 ? 'denied' : error.code === 3 ? 'timeout' : 'unavailable')
          },
          { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
        )
      } catch {
        onError('unavailable')
      }
      return () => {
        stopped = true
        try {
          if (id !== null) geolocation.clearWatch?.(id)
        } catch {
          // Nothing to do: the watch is not listened to any more.
        }
      }
    },
  }
}
