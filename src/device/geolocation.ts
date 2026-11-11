import { isValidLngLat, type LngLat } from '../core/index.ts'

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

/** The one method of the browser's Geolocation API that is used, so a test can hand in a stand-in. */
export interface GeolocationLike {
  getCurrentPosition(
    success: (position: { coords: { longitude: number; latitude: number; accuracy?: number } }) => void,
    error?: (error: { code: number }) => void,
    options?: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  ): void
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
