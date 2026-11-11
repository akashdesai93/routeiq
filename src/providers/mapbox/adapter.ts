import {
  alongRouteM,
  distanceM as distanceBetweenM,
  isValidLngLat,
  routeIdFromGeometry,
  type DistanceSpanM,
  type LngLat,
  type Maneuver,
  type RouteCandidate,
  type RouteIntersection,
} from '../../core/index.ts'

export type DirectionsErrorKind =
  /** Mapbox answered, but there is no drivable route (code NoRoute, or no routes). */
  | 'no-route'
  /** A pin is too far from any road (code NoSegment). */
  | 'no-segment'
  /** Any other Mapbox error code, such as InvalidInput. */
  | 'api'
  /** The body is not a Directions response, or no route in it is usable. */
  | 'malformed'
  /** Filled by the fetch client, never by the adapter. */
  | 'token'
  | 'rate-limit'
  | 'network'
  | 'aborted'

/** `message` is written for the user and never contains the token. */
export type DirectionsResult =
  | { readonly ok: true; readonly routes: readonly RouteCandidate[] }
  | { readonly ok: false; readonly kind: DirectionsErrorKind; readonly message: string }

const NO_ROUTE_HELP = 'No driving route found between these two points. Try moving a pin.'
const MALFORMED_HELP = 'Mapbox sent a response RouteIQ could not read. Try again.'

function fail(kind: DirectionsErrorKind, message: string): DirectionsResult {
  return { ok: false, kind, message }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nonNegative(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

function toLngLat(v: unknown): LngLat | null {
  if (!Array.isArray(v) || v.length < 2) return null
  const lng: unknown = v[0]
  const lat: unknown = v[1]
  if (typeof lng !== 'number' || typeof lat !== 'number') return null
  const p: LngLat = [lng, lat]
  return isValidLngLat(p) ? p : null
}

/** "turn right", "depart", "fork slight left": Mapbox maneuver type plus modifier. */
function maneuverKind(maneuver: Record<string, unknown>): string {
  const type = typeof maneuver.type === 'string' && maneuver.type !== '' ? maneuver.type : 'unknown'
  const modifier = typeof maneuver.modifier === 'string' ? maneuver.modifier : ''
  return modifier === '' ? type : `${type} ${modifier}`
}

/**
 * One maneuver per step, at the step's start, so atDistanceM is the sum of the
 * step distances before it (across legs). A step without a usable maneuver
 * location is skipped but its distance still counts.
 */
function toManeuvers(legs: unknown): Maneuver[] {
  const maneuvers: Maneuver[] = []
  if (!Array.isArray(legs)) return maneuvers
  let atDistanceM = 0
  for (const leg of legs as unknown[]) {
    if (!isRecord(leg) || !Array.isArray(leg.steps)) continue
    for (const step of leg.steps as unknown[]) {
      if (!isRecord(step)) continue
      if (isRecord(step.maneuver)) {
        const location = toLngLat(step.maneuver.location)
        if (location) maneuvers.push({ atDistanceM, kind: maneuverKind(step.maneuver), location })
      }
      atDistanceM += nonNegative(step.distance) ?? 0
    }
  }
  return maneuvers
}

/**
 * How many intersections along the route Mapbox flags with `traffic_signal`
 * (step.intersections[], present with steps=true). A cross-check for the
 * signal count, not a replacement. Null when no step carries an intersections
 * list, so "no data" is not mistaken for "no signals". An intersection that
 * repeats the location of the one just before it is counted once.
 */
function countSignalFlags(legs: unknown): number | null {
  if (!Array.isArray(legs)) return null
  let sawIntersections = false
  let count = 0
  let previous: string | null = null
  for (const leg of legs as unknown[]) {
    if (!isRecord(leg) || !Array.isArray(leg.steps)) continue
    for (const step of leg.steps as unknown[]) {
      if (!isRecord(step) || !Array.isArray(step.intersections)) continue
      sawIntersections = true
      for (const intersection of step.intersections as unknown[]) {
        if (!isRecord(intersection)) continue
        const at = toLngLat(intersection.location)
        const here = at === null ? null : at.join(',')
        if (intersection.traffic_signal === true && (here === null || here !== previous)) count++
        previous = here
      }
    }
  }
  return sawIntersections ? count : null
}

/**
 * Every intersection along the route with a usable location, in driving
 * order, each with Mapbox's `traffic_signal` flag (only a literal true
 * counts). core/signals.ts uses the locations to tell a signal the route
 * meets from one on a road passing over or under it, and the flags to stand
 * in where no signal data could be loaded. An intersection that repeats the
 * location of the one just before it (the end of one step is the start of
 * the next) is listed once. Null when no step carries an intersections list.
 */
function toIntersections(legs: unknown): RouteIntersection[] | null {
  if (!Array.isArray(legs)) return null
  let sawIntersections = false
  const found: RouteIntersection[] = []
  for (const leg of legs as unknown[]) {
    if (!isRecord(leg) || !Array.isArray(leg.steps)) continue
    for (const step of leg.steps as unknown[]) {
      if (!isRecord(step) || !Array.isArray(step.intersections)) continue
      sawIntersections = true
      for (const intersection of step.intersections as unknown[]) {
        if (!isRecord(intersection)) continue
        const location = toLngLat(intersection.location)
        if (location === null) continue
        const signal = intersection.traffic_signal === true
        const last = found.at(-1)
        if (last !== undefined && last.location[0] === location[0] && last.location[1] === location[1]) {
          if (signal && !last.signal) found[found.length - 1] = { location, signal }
          continue
        }
        found.push({ location, signal })
      }
    }
  }
  return sawIntersections ? found : null
}

/** Mapbox Streets v8 road classes that are controlled-access: freeway mainline, and its ramps and connectors. */
const LIMITED_ACCESS_CLASSES: ReadonlySet<string> = new Set(['motorway', 'motorway_link'])

/** An intersection must sit this close to the route point its geometry_index names, or the index is not trusted. */
const GEOMETRY_INDEX_CHECK_M = 5

/**
 * True when the road LEAVING this intersection is controlled-access. Two
 * fields say so, and either is enough:
 * - `classes` containing "motorway" (documented for every profile: "Road
 *   continues on a motorway").
 * - `mapbox_streets_v8.class` of motorway or motorway_link (documented for the
 *   driving profile only, but present on driving-traffic responses too).
 * In real Charlotte responses (checked Nov 11, 2026) the two always agreed:
 * Mapbox sets the "motorway" class on motorway_link ramps as well.
 */
function leavesOnLimitedAccess(intersection: Record<string, unknown>): boolean {
  if (Array.isArray(intersection.classes) && intersection.classes.includes('motorway')) return true
  const streets = intersection.mapbox_streets_v8
  return isRecord(streets) && typeof streets.class === 'string' && LIMITED_ACCESS_CLASSES.has(streets.class)
}

/**
 * The stretches of the route on controlled-access road, as [startM, endM]
 * along `geometry` (see RouteCandidate.limitedAccessSpansM).
 *
 * Each step intersection describes the road leaving it, up to the next
 * intersection, and `geometry_index` (documented for driving-traffic) places
 * it on the route line. A span opens at the first intersection whose exit is
 * controlled-access and closes at the next one whose exit is not.
 *
 * Ramp rule: ramps tagged motorway_link ARE inside the span, because a
 * freeway-to-freeway connector flies over signalized streets just as the
 * mainline does. The light at the foot of an off-ramp is not lost: the span
 * closes at that very intersection (the road leaving it is a street), and
 * core/signals.ts keeps signals within a margin of a span end. In the
 * Charlotte responses checked, exit ramps to streets were not even
 * motorway_link: Mapbox classes them by the street they lead to
 * (primary_link, tertiary_link), so they fall outside the span altogether.
 * Expressways with traffic lights (class trunk) are never limited-access here.
 *
 * Null, meaning unknown, whenever the data is not exactly as expected (no
 * intersections, a missing or out-of-order index, an index that does not
 * land on the intersection's location): then nothing is filtered.
 * `geometry_index` counts from the start of its leg; the next leg starts at
 * the point where the last one arrived.
 */
function toLimitedAccessSpans(legs: unknown, geometry: readonly LngLat[]): DistanceSpanM[] | null {
  if (!Array.isArray(legs)) return null
  const along = alongRouteM(geometry)
  const spans: DistanceSpanM[] = []
  let legStart = 0
  let previous = -1
  let openedAtM: number | null = null
  const close = (startM: number, endM: number) => {
    const last = spans.at(-1)
    // A waypoint in the middle of a freeway ends one leg and starts the next at the same point: one span.
    if (last !== undefined && last[1] === startM) spans[spans.length - 1] = [last[0], endM]
    else if (endM > startM) spans.push([startM, endM])
  }
  for (const leg of legs as unknown[]) {
    if (!isRecord(leg) || !Array.isArray(leg.steps)) return null
    if (previous >= 0) legStart = previous
    for (const step of leg.steps as unknown[]) {
      if (!isRecord(step) || !Array.isArray(step.intersections)) return null
      for (const intersection of step.intersections as unknown[]) {
        if (!isRecord(intersection)) return null
        const offset = intersection.geometry_index
        const location = toLngLat(intersection.location)
        if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || location === null) return null
        const index = legStart + offset
        const point = geometry[index]
        if (point === undefined || index < previous) return null
        if (distanceBetweenM(location, point) > GEOMETRY_INDEX_CHECK_M) return null
        previous = index
        const atM = along[index]!
        if (leavesOnLimitedAccess(intersection)) {
          openedAtM ??= atM
        } else if (openedAtM !== null) {
          close(openedAtM, atM)
          openedAtM = null
        }
      }
    }
  }
  if (previous < 0) return null
  const endM = along.at(-1)!
  if (openedAtM !== null) close(openedAtM, endM)
  return spans
}

/** Null when the route lacks what the app cannot do without: a line, a time, a length. */
function toCandidate(route: unknown): RouteCandidate | null {
  if (!isRecord(route)) return null
  const durationSec = nonNegative(route.duration)
  const distanceM = nonNegative(route.distance)
  if (durationSec === null || distanceM === null) return null
  if (!isRecord(route.geometry) || !Array.isArray(route.geometry.coordinates)) return null
  const coordinates = route.geometry.coordinates as unknown[]
  const geometry = coordinates.map(toLngLat).filter((p): p is LngLat => p !== null)
  if (geometry.length < 2) return null
  return {
    id: routeIdFromGeometry(geometry),
    geometry,
    durationSec,
    // Only the driving-traffic profile sends this. Missing stays null, never guessed.
    typicalDurationSec: nonNegative(route.duration_typical),
    distanceM,
    // Filled later from signal data (core/signals.ts).
    signalCount: null,
    signalCoverage: 'none',
    providerSignalCount: countSignalFlags(route.legs),
    intersections: toIntersections(route.legs),
    // A dropped point shifts every geometry_index after it, so the spans would be misplaced.
    limitedAccessSpansM:
      geometry.length === coordinates.length ? toLimitedAccessSpans(route.legs, geometry) : null,
    maneuvers: toManeuvers(route.legs),
  }
}

/**
 * Turns a Mapbox Directions API v5 JSON body (geometries=geojson, steps=true)
 * into RouteCandidates. Pure, and never throws: anything unexpected comes back
 * as a typed failure. Route ids come from the geometry (core/hash.ts), so the
 * same route keeps its id from one response to the next; if two routes in one
 * response somehow share a geometry, the later one gets a "-2" style suffix.
 */
export function parseDirections(body: unknown): DirectionsResult {
  if (!isRecord(body)) return fail('malformed', MALFORMED_HELP)
  const code = typeof body.code === 'string' ? body.code : null
  if (code === null) return fail('malformed', MALFORMED_HELP)
  if (code === 'NoRoute') return fail('no-route', NO_ROUTE_HELP)
  if (code === 'NoSegment')
    return fail('no-segment', 'A pin is too far from a road. Move it closer to a street.')
  if (code !== 'Ok') {
    const detail = typeof body.message === 'string' && body.message !== '' ? `: ${body.message}` : ''
    return fail('api', `Mapbox Directions error (${code})${detail}`)
  }
  if (!Array.isArray(body.routes)) return fail('malformed', MALFORMED_HELP)
  if (body.routes.length === 0) return fail('no-route', NO_ROUTE_HELP)
  const copies = new Map<string, number>()
  const routes: RouteCandidate[] = []
  for (const raw of body.routes as unknown[]) {
    const route = toCandidate(raw)
    if (route === null) continue
    const copy = (copies.get(route.id) ?? 0) + 1
    copies.set(route.id, copy)
    routes.push(copy === 1 ? route : { ...route, id: `${route.id}-${copy}` })
  }
  if (routes.length === 0) return fail('malformed', MALFORMED_HELP)
  return { ok: true, routes }
}
