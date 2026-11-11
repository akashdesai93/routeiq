import { isValidLngLat, type LngLat, type RouteCandidate } from '../../core/index.ts'
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

/** A point a route has to pass through, with the direction of travel there when it is known. */
export interface ViaPoint {
  readonly point: LngLat
  /** Degrees clockwise from true north. Sent as that coordinate's `bearings` entry. */
  readonly bearingDeg?: number
  /**
   * How far Mapbox may move the point to snap it onto a road, in meters. Sent
   * as that coordinate's `radiuses` entry; left out (or not a positive number)
   * it is `unlimited`, as the origin and destination always are.
   */
  readonly radiusM?: number
}

/**
 * The most via points one request carries. The Directions API takes 25
 * coordinates per request on every profile, driving-traffic included (docs
 * checked Nov 2026); two of them are the origin and the destination.
 */
export const MAX_VIA_POINTS = 23

export interface DirectionsUrlOptions {
  /**
   * The vehicle's heading at the origin, in degrees clockwise from true
   * north, for a request made while moving (a reroute poll). Sent as the
   * `bearings` parameter for the origin only, so the routes start in the
   * direction of travel instead of with a U-turn or on the other side of a
   * divided road. Left out, or not a number, the request has no bearings.
   */
  originHeadingDeg?: number
  /**
   * Points the route must pass through, in order, between the origin and
   * the destination: the way to ask for the travel time of one particular
   * path (the route being driven, when a poll did not return it). They are
   * sent as coordinates that are NOT waypoints (`waypoints=0;N` names only
   * the origin and the destination), so the answer is still one leg with no
   * "arrive" maneuvers on the way. With via points no alternatives are asked
   * for: the question is about this path only. Points past MAX_VIA_POINTS
   * and points that are not coordinates are left out.
   */
  via?: readonly ViaPoint[]
}

/**
 * Directions request URL: traffic-aware driving, with alternatives, full GeoJSON
 * geometry, steps, the banner and voice instructions of each step, and the
 * congestion and travel time of every segment of the line. Coordinates go longitude,latitude, joined by an encoded
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
  const via = (options.via ?? []).filter((v) => isValidLngLat(v.point)).slice(0, MAX_VIA_POINTS)
  const query = new URLSearchParams({
    alternatives: via.length === 0 ? 'true' : 'false',
    geometries: 'geojson',
    overview: 'full',
    steps: 'true',
    // Turn guidance for a live drive (Directions docs, checked Nov 2026: both need
    // steps=true and are available on every profile). voice_units is the unit of the
    // distances in the spoken text; imperial is also the API's default.
    banner_instructions: 'true',
    voice_instructions: 'true',
    voice_units: 'imperial',
    // Per-segment traffic along the line (Directions docs, `annotations`, checked Nov 11, 2026):
    // "congestion" is "only available for the mapbox/driving-traffic profile" and is one of
    // low, moderate, heavy, severe or unknown; "duration" is the time between each pair of
    // coordinates. It "must be used in conjunction with overview=full". Same request, same
    // price: the API is "billed by requests", whatever the parameters.
    annotations: 'congestion,duration',
  })
  // One "angle,range" per coordinate, semicolon-separated; an empty entry leaves
  // that coordinate free, as the destination always is (Mapbox docs: bearings).
  const bearing = (deg: number | undefined) =>
    deg !== undefined && Number.isFinite(deg) ? `${((Math.round(deg) % 360) + 360) % 360},${HEADING_RANGE_DEG}` : ''
  const bearings = [bearing(options.originHeadingDeg), ...via.map((v) => bearing(v.bearingDeg)), '']
  if (bearings.some((b) => b !== '')) query.set('bearings', bearings.join(';'))
  // Mapbox docs (Directions, `radiuses`, checked Nov 2026): "There must be as many radiuses
  // as there are coordinates in the request", each "any number greater than 0 or the string
  // unlimited", and "A NoSegment error is returned if no routable road is located within the
  // radius". Sent only when a via sets one.
  const radius = (m: number | undefined) => (m !== undefined && Number.isFinite(m) && m > 0 ? String(Math.max(1, Math.round(m))) : 'unlimited')
  const radiuses = ['unlimited', ...via.map((v) => radius(v.radiusM)), 'unlimited']
  if (radiuses.some((r) => r !== 'unlimited')) query.set('radiuses', radiuses.join(';'))
  // Only the first and the last coordinate are waypoints; the ones between guide the path.
  if (via.length > 0) query.set('waypoints', `0;${via.length + 1}`)
  query.set('access_token', token)
  const coordinates = [origin, ...via.map((v) => v.point), destination].map(coordinate).join('%3B')
  return `${DIRECTIONS_BASE}/${coordinates}?${query.toString()}`
}

export interface FetchDirectionsOptions {
  origin: LngLat
  destination: LngLat
  token: string
  /** See DirectionsUrlOptions: the heading of a moving vehicle at the origin. */
  originHeadingDeg?: number
  /** See DirectionsUrlOptions: points the route must pass through. */
  via?: readonly ViaPoint[]
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
  const { origin, destination, token, originHeadingDeg, via, signal, fetchImpl = fetch } = options
  const url = buildDirectionsUrl(origin, destination, token, { originHeadingDeg, via })
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

export interface FetchProbeRouteOptions {
  origin: LngLat
  /** The point beside the fastest route to go through (see planProbes in core/probe.ts). */
  via: LngLat
  destination: LngLat
  token: string
  /**
   * How far the via may be moved onto a road, in meters (ProbeOptions.viaRadiusM).
   * A via with no road this close comes back as NoSegment, so null. Left out: unlimited.
   */
  viaRadiusM?: number
  /** The vehicle's heading at the origin, for a probe made during a drive (see DirectionsUrlOptions.originHeadingDeg). */
  originHeadingDeg?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/**
 * One side-street probe: origin → via → destination on driving-traffic, the
 * via sent as a silent waypoint (`waypoints=0;2`, see buildDirectionsUrl), so
 * the answer is one leg with no stop at the via and its ETA is a drive
 * straight through. Mapbox docs (Directions, `waypoints`, checked Nov 2026):
 * "guide the path of the route without introducing additional legs".
 * The via goes with a `radiuses` entry of `viaRadiusM` (the ends unlimited),
 * so a via in a field or a lake is NoSegment rather than snapped onto the
 * nearest road, which is often the base route itself or a dead end.
 *
 * Null for anything but a usable route: NoSegment (the via is too far from a
 * road), NoRoute, an HTTP or network error, rate limiting, an abort. A probe
 * is extra, so its failure is dropped silently and never reaches the user.
 */
export async function fetchProbeRoute(options: FetchProbeRouteOptions): Promise<RouteCandidate | null> {
  const { origin, via, destination, token, viaRadiusM, originHeadingDeg, signal, fetchImpl } = options
  // buildDirectionsUrl leaves a bad via out, which would ask for the plain trip instead.
  if (!isValidLngLat(via)) return null
  const result = await fetchDirections({ origin, destination, token, originHeadingDeg, via: [{ point: via, radiusM: viaRadiusM }], signal, fetchImpl })
  return result.ok ? (result.routes[0] ?? null) : null
}
