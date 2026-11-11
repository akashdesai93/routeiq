import { alongRouteM, boundsOf, distanceM, isValidLngLat, localProjector, pointAtDistance, pointToSegment, type XY } from './geo.ts'
import { sameRouteGeometry } from './select.ts'
import type { LngLat, RouteCandidate } from './types.ts'

/**
 * Route hand-off to Google Maps and Waze (PLAN step 9).
 *
 * Google Maps picks its own route between origin and destination. To make it
 * drive the route RouteIQ accepted, handoffWaypoints puts a few points on the
 * accepted route just after each place where an alternative leaves it: a
 * route through those points cannot be that alternative. Google treats each
 * waypoint as a stop, so this pins the roads chosen, not every turn.
 *
 * Waze deep links take a destination only, so its hand-off has no waypoints.
 *
 * Pure and deterministic: the same routes and options always give the same
 * points and the same URLs. No time, no randomness, no I/O.
 */

/** Google Maps URLs: "up to three waypoints supported on mobile browsers". */
export const GOOGLE_MAPS_MAX_WAYPOINTS_MOBILE = 3
/** Google Maps URLs: "a maximum of nine waypoints supported otherwise". */
export const GOOGLE_MAPS_MAX_WAYPOINTS = 9
/** Google Maps URLs: "URLs are limited to 2,048 characters for each request". */
export const GOOGLE_MAPS_MAX_URL_LENGTH = 2048

export interface HandoffOptions {
  /** Most waypoints returned: 3 for a mobile browser, 9 elsewhere (Google's limits). */
  readonly maxWaypoints: number
  /** The accepted route is sampled every this many meters to find where alternatives leave it. */
  readonly sampleStepM: number
  /** A sample this close (meters) to an alternative's line counts as on that alternative too. */
  readonly sharedToleranceM: number
  /** A stretch where an alternative is away from the accepted route must be at least this long (meters) to count as a split. Shorter ones are line jitter or a lane. */
  readonly minDivergenceM: number
  /** A shared stretch shorter than this (meters) inside a divergence, such as the alternative crossing the route, does not end it. */
  readonly minSharedM: number
  /** The waypoint goes this many meters past the split, on the accepted route: far enough to be clearly on the chosen road. */
  readonly afterSplitM: number
  /**
   * No waypoint within this many meters of the origin or destination, along
   * the route or in a straight line. A stop there only bends the first or last
   * block and adds a pointless "arrive".
   */
  readonly endpointClearanceM: number
  /** Google Maps URL length cap; waypoints are dropped, least decisive first, until the URL fits. */
  readonly maxUrlLength: number
  /** Decimal places for coordinates in URLs. 6 is about 0.1 m. */
  readonly coordinateDecimals: number
}

export const DEFAULT_HANDOFF_OPTIONS: HandoffOptions = {
  maxWaypoints: GOOGLE_MAPS_MAX_WAYPOINTS_MOBILE,
  sampleStepM: 25,
  sharedToleranceM: 30,
  minDivergenceM: 300,
  minSharedM: 200,
  afterSplitM: 150,
  endpointClearanceM: 500,
  maxUrlLength: GOOGLE_MAPS_MAX_URL_LENGTH,
  coordinateDecimals: 6,
}

/** One point to route Google Maps through, on the accepted route. */
export interface HandoffWaypoint {
  readonly position: LngLat
  /** Where it sits on the accepted route, in meters from the start. */
  readonly atDistanceM: number
  /**
   * How long the longest divergence it rules out is, in meters along the
   * accepted route. Bigger means a bigger road choice; the least decisive
   * waypoints are dropped first.
   */
  readonly decisivenessM: number
  /** Ids of the alternatives a route through this point cannot be (for the divergence it pins). */
  readonly excludesRouteIds: readonly string[]
}

interface Divergence {
  readonly startM: number
  readonly endM: number
  readonly routeId: string
  /** Per sample of the accepted route: true where this alternative is away from it. Short shared gaps inside [startM, endM] stay false. */
  readonly off: readonly boolean[]
}

const usable = (line: readonly LngLat[]) => line.length >= 2 && line.every(isValidLngLat)

function nearLine(p: XY, line: readonly XY[], toleranceM: number): boolean {
  for (let i = 1; i < line.length; i++) {
    if (pointToSegment(p, line[i - 1]!, line[i]!).distanceM <= toleranceM) return true
  }
  return false
}

/** Stretches of the accepted route (sampled at `samplesM`) where `off[i]` holds, merged across short shared gaps. */
function divergences(samplesM: readonly number[], off: readonly boolean[], routeId: string, o: HandoffOptions): Divergence[] {
  const runs: { startM: number; endM: number }[] = []
  let start: number | null = null
  off.forEach((isOff, i) => {
    if (isOff && start === null) start = samplesM[i]!
    if (!isOff && start !== null) {
      runs.push({ startM: start, endM: samplesM[i - 1]! })
      start = null
    }
  })
  if (start !== null) runs.push({ startM: start, endM: samplesM.at(-1)! })
  const merged: { startM: number; endM: number }[] = []
  for (const run of runs) {
    const last = merged.at(-1)
    if (last !== undefined && run.startM - last.endM < o.minSharedM) last.endM = run.endM
    else merged.push({ ...run })
  }
  return merged.filter((r) => r.endM - r.startM >= o.minDivergenceM).map((r) => ({ ...r, routeId, off }))
}

/**
 * Points on `accepted` that pin Google Maps to it, in driving order: one just
 * after each split where an alternative leaves the accepted route. At most
 * `options.maxWaypoints`; when there are more splits than that, each
 * alternative's longest divergence comes first (so as many alternatives as
 * possible are ruled out), then the other divergences, longest first. One waypoint serves every
 * alternative whose divergence it lies in. Empty when no alternative differs
 * (identical routes give no splits), when every split is too close to an end,
 * or when the accepted route is unusable.
 */
export function handoffWaypoints(
  accepted: RouteCandidate,
  alternatives: readonly RouteCandidate[],
  options: Partial<HandoffOptions> = {},
): HandoffWaypoint[] {
  const o: HandoffOptions = { ...DEFAULT_HANDOFF_OPTIONS, ...options }
  const maxWaypoints = Math.min(Math.floor(o.maxWaypoints), GOOGLE_MAPS_MAX_WAYPOINTS)
  if (!usable(accepted.geometry) || maxWaypoints <= 0 || !(o.sampleStepM > 0)) return []
  const line = accepted.geometry
  const lengthM = alongRouteM(line).at(-1)!
  const origin = line[0]!
  const destination = line.at(-1)!
  const [west, south, east, north] = boundsOf(line)
  const project = localProjector([(west + east) / 2, (south + north) / 2])

  const samplesM: number[] = []
  for (let m = 0; m < lengthM; m += o.sampleStepM) samplesM.push(m)
  samplesM.push(lengthM)
  const samples = samplesM.map((m) => project(pointAtDistance(line, m)!.point))

  const others = alternatives.filter(
    (alt) => alt.id !== accepted.id && usable(alt.geometry) && !sameRouteGeometry(alt.geometry, line),
  )
  const all: Divergence[] = []
  for (const alt of others) {
    const altXY = alt.geometry.map(project)
    const off = samples.map((p) => !nearLine(p, altXY, o.sharedToleranceM))
    all.push(...divergences(samplesM, off, alt.id, o))
  }
  // Most decisive first; ties go to the earlier split, then the smaller id, so input order never matters.
  all.sort(
    (a, b) =>
      b.endM - b.startM - (a.endM - a.startM) ||
      a.startM - b.startM ||
      (a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0),
  )

  // Waypoints sit on samples only, and only where the alternative they rule out is
  // away from the accepted route: a point in a short shared gap would not exclude it.
  const rulesOut = (i: number, d: Divergence) => samplesM[i]! >= d.startM && samplesM[i]! <= d.endM && d.off[i]!
  const chosen: { i: number; position: LngLat; decisivenessM: number; excludes: Set<string> }[] = []
  const place = (d: Divergence) => {
    const covering = chosen.find((c) => rulesOut(c.i, d))
    if (covering !== undefined) {
      covering.excludes.add(d.routeId)
      return
    }
    if (chosen.length >= maxWaypoints) return
    // Just past the split, moved on a sample at a time until off the alternative and clear of both ends.
    const fromM = Math.max(d.startM + o.afterSplitM, o.endpointClearanceM)
    const toM = Math.min(d.endM, lengthM - o.endpointClearanceM)
    for (let i = 0; i < samplesM.length && samplesM[i]! <= toM; i++) {
      if (samplesM[i]! < fromM || !rulesOut(i, d)) continue
      const p = pointAtDistance(line, samplesM[i]!)!.point
      if (distanceM(p, origin) < o.endpointClearanceM || distanceM(p, destination) < o.endpointClearanceM) continue
      chosen.push({ i, position: p, decisivenessM: d.endM - d.startM, excludes: new Set([d.routeId]) })
      return
    }
  }
  // First every alternative's most decisive divergence, so a small budget rules out
  // as many alternatives as it can; then the remaining divergences, longest first.
  const firsts = new Set<Divergence>()
  for (const d of all) {
    if (!chosen.some((c) => c.excludes.has(d.routeId)) && ![...firsts].some((f) => f.routeId === d.routeId)) {
      firsts.add(d)
      place(d)
    }
  }
  for (const d of all) if (!firsts.has(d)) place(d)
  return chosen
    .sort((a, b) => a.i - b.i)
    .map((c) => ({
      position: c.position,
      atDistanceM: samplesM[c.i]!,
      decisivenessM: c.decisivenessM,
      excludesRouteIds: [...c.excludes].sort(),
    }))
}

/** "lat,lng" with a fixed number of decimals (Google and Waze both take latitude first). */
function latLng([lng, lat]: LngLat, decimals: number): string {
  return `${lat.toFixed(decimals)},${lng.toFixed(decimals)}`
}

/**
 * A Google Maps URLs API directions link (driving) from origin to destination
 * through the waypoints, in their order. Values are percent-encoded, so the
 * comma in each coordinate is %2C and the pipe between waypoints is %7C, as
 * the API asks. Waypoints past Google's maximum of nine, and then any that
 * would take the URL past `maxUrlLength`, are dropped least decisive first
 * (ties: the later one); the order of the rest is kept. A null origin is left
 * out of the URL: Google then starts from the device's own position, which is
 * how a trip from "my location" is handed off without RouteIQ sending it.
 */
export function googleMapsUrl(
  origin: LngLat | null,
  destination: LngLat,
  waypoints: readonly HandoffWaypoint[],
  options: Partial<Pick<HandoffOptions, 'maxUrlLength' | 'coordinateDecimals'>> = {},
): string {
  const { maxUrlLength, coordinateDecimals } = { ...DEFAULT_HANDOFF_OPTIONS, ...options }
  const build = (kept: readonly HandoffWaypoint[]) => {
    const params = [
      'api=1',
      ...(origin === null ? [] : [`origin=${encodeURIComponent(latLng(origin, coordinateDecimals))}`]),
      `destination=${encodeURIComponent(latLng(destination, coordinateDecimals))}`,
      'travelmode=driving',
    ]
    if (kept.length > 0) {
      params.push(`waypoints=${encodeURIComponent(kept.map((w) => latLng(w.position, coordinateDecimals)).join('|'))}`)
    }
    return `https://www.google.com/maps/dir/?${params.join('&')}`
  }
  // Drop order: least decisive first, the later one first on a tie.
  const dropOrder = waypoints
    .map((w, i) => ({ w, i }))
    .sort((a, b) => a.w.decisivenessM - b.w.decisivenessM || b.i - a.i)
    .map(({ i }) => i)
  const dropped = new Set<number>()
  const kept = () => waypoints.filter((_, i) => !dropped.has(i))
  let next = 0
  while (kept().length > GOOGLE_MAPS_MAX_WAYPOINTS) dropped.add(dropOrder[next++]!)
  let url = build(kept())
  while (url.length > maxUrlLength && next < dropOrder.length) {
    dropped.add(dropOrder[next++]!)
    url = build(kept())
  }
  return url
}

/** A Waze deep link that starts navigation to the destination. Waze takes no waypoints. */
export function wazeUrl(
  destination: LngLat,
  options: Partial<Pick<HandoffOptions, 'coordinateDecimals'>> = {},
): string {
  const { coordinateDecimals } = { ...DEFAULT_HANDOFF_OPTIONS, ...options }
  return `https://waze.com/ul?ll=${encodeURIComponent(latLng(destination, coordinateDecimals))}&navigate=yes`
}
