import { isValidLngLat, type LngLat } from '../../core/index.ts'
import { tokenErrorHelp } from '../../config.ts'
import { parseDirections, type DirectionsResult } from './adapter.ts'

const DIRECTIONS_BASE = 'https://api.mapbox.com/directions/v5/mapbox/driving-traffic'

/** Six decimals is about 0.1 m, plenty for a pin and it keeps the URL short. */
function coordinate([lng, lat]: LngLat): string {
  return `${Number(lng.toFixed(6))},${Number(lat.toFixed(6))}`
}

/**
 * How far either side of the heading a road may point and still be the road
 * the vehicle is on, in degrees. Mapbox recommends 45 or 90; 45 keeps the
 * opposite carriageway and most cross streets out.
 */
export const HEADING_RANGE_DEG = 45

export interface DirectionsUrlOptions {
  /**
   * The vehicle's heading at the origin, in degrees clockwise from true
   * north, for a request made while moving (a reroute poll). Sent as the
   * `bearings` parameter for the origin only, so the routes start in the
   * direction of travel instead of with a U-turn or on the other side of a
   * divided road. Left out, or not a number, the request has no bearings.
   */
  originHeadingDeg?: number
}

/**
 * Directions request URL: traffic-aware driving, with alternatives, full GeoJSON
 * geometry and steps. Coordinates go longitude,latitude, joined by an encoded
 * semicolon as the Mapbox docs show. Null when a coordinate is not valid.
 *
 * No `depart_at`: without it driving-traffic routes for "now" on live traffic,
 * which is what a poll from the vehicle's position wants.
 */
export function buildDirectionsUrl(
  origin: LngLat,
  destination: LngLat,
  token: string,
  options: DirectionsUrlOptions = {},
): string | null {
  if (!isValidLngLat(origin) || !isValidLngLat(destination)) return null
  const query = new URLSearchParams({
    alternatives: 'true',
    geometries: 'geojson',
    overview: 'full',
    steps: 'true',
  })
  const heading = options.originHeadingDeg
  if (heading !== undefined && Number.isFinite(heading)) {
    // One "angle,range" per coordinate, semicolon-separated; the empty entry
    // after the semicolon leaves the destination free (Mapbox docs: bearings).
    const angle = ((Math.round(heading) % 360) + 360) % 360
    query.set('bearings', `${angle},${HEADING_RANGE_DEG};`)
  }
  query.set('access_token', token)
  return `${DIRECTIONS_BASE}/${coordinate(origin)}%3B${coordinate(destination)}?${query.toString()}`
}

export interface FetchDirectionsOptions {
  origin: LngLat
  destination: LngLat
  token: string
  /** See DirectionsUrlOptions: the heading of a moving vehicle at the origin. */
  originHeadingDeg?: number
  /** Aborting resolves with kind 'aborted'; the caller should ignore that result. */
  signal?: AbortSignal
  /** Swapped out in tests so they never touch the network. */
  fetchImpl?: typeof fetch
}

/**
 * Asks Mapbox for routes. Never rejects: HTTP, network and abort failures all
 * come back as a typed result with a message fit to show the user.
 */
export async function fetchDirections(options: FetchDirectionsOptions): Promise<DirectionsResult> {
  const { origin, destination, token, originHeadingDeg, signal, fetchImpl = fetch } = options
  const url = buildDirectionsUrl(origin, destination, token, { originHeadingDeg })
  if (url === null)
    return { ok: false, kind: 'malformed', message: 'A pin is not at a valid map coordinate.' }

  let status: number
  let body: unknown = null
  try {
    const response = await fetchImpl(url, { signal })
    status = response.status
    // Error bodies below 500 are JSON too ({ code, message }); anything else stays null.
    body = await response.json().catch(() => null)
  } catch {
    if (signal?.aborted) return { ok: false, kind: 'aborted', message: 'Route request cancelled.' }
    // The thrown error is deliberately not shown: it adds nothing for the user.
    return {
      ok: false,
      kind: 'network',
      message: 'Could not reach Mapbox. Check your internet connection and try again.',
    }
  }
  if (signal?.aborted) return { ok: false, kind: 'aborted', message: 'Route request cancelled.' }

  const tokenHelp = tokenErrorHelp(status)
  if (tokenHelp !== null) return { ok: false, kind: 'token', message: tokenHelp }
  if (status === 429)
    return {
      ok: false,
      kind: 'rate-limit',
      message: 'Mapbox is rate limiting route requests (429). Wait a minute, then try again.',
    }

  const result = parseDirections(body)
  if (status >= 200 && status < 300) return redact(result, token)
  // Non-2xx: keep Mapbox's own explanation when it sent one (422 InvalidInput, 404 ProfileNotFound).
  if (!result.ok && result.kind === 'api') return redact(result, token)
  return {
    ok: false,
    kind: 'api',
    message: `Mapbox Directions is not available right now (HTTP ${status}). Try again shortly.`,
  }
}

/** Belt and braces: an API message that echoes the request must not show the token. */
function redact(result: DirectionsResult, token: string): DirectionsResult {
  if (result.ok || token === '' || !result.message.includes(token)) return result
  return { ...result, message: result.message.replaceAll(token, '[token]') }
}
