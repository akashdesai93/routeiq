import { alongRouteM, bearingDeg, distanceM, isValidLngLat, localProjector, pointToSegment } from './geo.ts'
import type { LngLat } from './types.ts'

/**
 * Position tracking for a live drive: turns the device's raw position fixes
 * into "where on the route is the car": a point on the route line, the meters
 * driven along it, a steady speed, a heading, and two verdicts that are not
 * given lightly: off the route, and arrived.
 *
 * Pure: the state is plain data the caller keeps between fixes, time comes in
 * with each fix, and the same fixes always give the same answer. A native
 * shell feeds it Core Location fixes unchanged.
 */

/** One reading from a position source (GPS). Kept in memory only, never stored or logged. */
export interface PositionFix {
  readonly lng: number
  readonly lat: number
  /** Radius of the fix in meters (the device's 68% circle). Not a number when the device gives none. */
  readonly accuracyM: number
  /** Ground speed from the device, in meters per second. Null when it gives none. */
  readonly speedMps: number | null
  /** Direction of travel from the device, degrees clockwise from true north. Null when it gives none. */
  readonly headingDeg: number | null
  /** When the fix was taken, in milliseconds on a clock that only moves forward. */
  readonly timeMs: number
}

/** Every threshold of the tracker, in one place. See DEFAULT_TRACKING_OPTIONS for the values. */
export interface TrackingOptions {
  /** A fix whose accuracy radius is larger than this is ignored altogether, in meters. */
  readonly maxAccuracyM: number
  /** Farther than this from the route line, a fix is "off the line", in meters. */
  readonly offRouteM: number
  /** The driver is off the route once fixes have been off the line for this many seconds... */
  readonly offRoutePatienceSec: number
  /** ...or for this many good fixes in a row, whichever comes first. Never on one fix (values below 2 count as 2). */
  readonly offRouteFixes: number
  /** Arrived when this close to the destination, along the route or in a straight line, in meters. */
  readonly arrivalRadiusM: number
  /**
   * The straight-line arrival test only applies on the last stretch of the
   * route, this many meters or less from its end: a route that passes its own
   * destination early on has not arrived there.
   */
  readonly arrivalZoneM: number
  /**
   * Progress never moves back by noise: a fix that snaps up to this many
   * meters behind the last position leaves the position where it was.
   */
  readonly backwardToleranceM: number
  /**
   * A fix that snaps farther back than that, or farther ahead than the car
   * could have driven, is believed only after this many such fixes in a row:
   * a real U-turn or a jump after a long gap, not a stray reading.
   */
  readonly jumpFixes: number
  /** The fastest the car is taken to move, in meters per second: bounds how far ahead a fix may snap. */
  readonly maxSpeedMps: number
  /** A fix may always snap this far ahead of the last position, whatever the time between them, in meters. */
  readonly minReachM: number
  /** Weight of the newest speed reading in the smoothed speed, from 0 (never changes) to 1 (no smoothing). */
  readonly speedSmoothing: number
  /** Below this smoothed speed the car counts as standing still, in meters per second. */
  readonly stoppedSpeedMps: number
}

/** The one place the defaults are set. Pass any subset to trackFix to override. */
export const DEFAULT_TRACKING_OPTIONS: TrackingOptions = {
  maxAccuracyM: 50,
  offRouteM: 50,
  offRoutePatienceSec: 8,
  offRouteFixes: 3,
  arrivalRadiusM: 40,
  arrivalZoneM: 400,
  backwardToleranceM: 30,
  jumpFixes: 3,
  maxSpeedMps: 50,
  minReachM: 150,
  speedSmoothing: 0.4,
  stoppedSpeedMps: 1,
}

/** A route line prepared for tracking: its usable points and the meters along it to each. */
export interface TrackedRoute {
  readonly line: readonly LngLat[]
  readonly alongM: readonly number[]
  readonly lengthM: number
}

const prepared = new WeakMap<readonly LngLat[], TrackedRoute>()

/** Prepares a route geometry for tracking. The answer for one geometry array is worked out once and kept. */
export function trackedRoute(geometry: readonly LngLat[]): TrackedRoute {
  const known = prepared.get(geometry)
  if (known !== undefined) return known
  const line = geometry.filter(isValidLngLat)
  const alongM = alongRouteM(line)
  const made: TrackedRoute = { line, alongM, lengthM: alongM.at(-1) ?? 0 }
  prepared.set(geometry, made)
  return made
}

/** Where the car is on the route, as of the last good fix. Plain data: keep it, pass it back, never edit it. */
export interface TrackingState {
  /** The last good fix as the device gave it. */
  readonly fix: PositionFix
  /** Where to draw the car: the point on the route line while on it, the raw fix while off the line. */
  readonly position: LngLat
  /** Meters driven along the route, from its start. Does not move back on noise. */
  readonly alongRouteM: number
  /** Meters of route still ahead. */
  readonly remainingM: number
  /** Smoothed speed, in meters per second. */
  readonly speedMps: number
  /** Direction of travel: the device's while moving, otherwise the route's at the car. Degrees clockwise from north. */
  readonly headingDeg: number
  /** How far the last good fix was from the route line, in meters. */
  readonly distanceFromRouteM: number
  /** The verdict, given with patience: off the route. */
  readonly offRoute: boolean
  /** The verdict: at the destination, or past the end of the route. */
  readonly arrived: boolean
  /** Since when the car has been standing still (the time of that fix). Null while it moves. */
  readonly stoppedSinceMs: number | null
  /** Since when fixes have been off the line. Null while on it. */
  readonly offSinceMs: number | null
  /** Good fixes in a row that were off the line. */
  readonly offFixes: number
  /** Good fixes in a row that snapped outside where the car could be (see TrackingOptions.jumpFixes). */
  readonly jumpFixes: number
  /** True after a confirmed move backwards, until the car makes progress again: fixes behind are then followed at once. */
  readonly reversing: boolean
  /** Fixes ignored so far (poor accuracy, not a coordinate, out of order). */
  readonly ignoredFixes: number
}

function resolve(options: Partial<TrackingOptions>): TrackingOptions {
  const d = DEFAULT_TRACKING_OPTIONS
  const pick = (key: keyof TrackingOptions) => {
    const v = options[key]
    return v !== undefined && Number.isFinite(v) && v >= 0 ? v : d[key]
  }
  return {
    maxAccuracyM: pick('maxAccuracyM'),
    offRouteM: pick('offRouteM'),
    offRoutePatienceSec: pick('offRoutePatienceSec'),
    offRouteFixes: Math.max(2, Math.round(pick('offRouteFixes'))),
    arrivalRadiusM: pick('arrivalRadiusM'),
    arrivalZoneM: pick('arrivalZoneM'),
    backwardToleranceM: pick('backwardToleranceM'),
    jumpFixes: Math.max(1, Math.round(pick('jumpFixes'))),
    maxSpeedMps: pick('maxSpeedMps'),
    minReachM: pick('minReachM'),
    speedSmoothing: Math.min(1, pick('speedSmoothing')),
    stoppedSpeedMps: pick('stoppedSpeedMps'),
  }
}

/** True when a fix is good enough to track with. A fix without an accuracy is taken on trust. */
export function isUsableFix(fix: PositionFix, options: Partial<TrackingOptions> = {}): boolean {
  const maxAccuracyM = resolve(options).maxAccuracyM
  return (
    typeof fix.lng === 'number' &&
    typeof fix.lat === 'number' &&
    isValidLngLat([fix.lng, fix.lat]) &&
    Number.isFinite(fix.timeMs) &&
    !(fix.accuracyM > maxAccuracyM)
  )
}

/** A place where the route passes the fix: the closest point of one unbroken stretch of nearby route. */
interface Pass {
  readonly alongM: number
  readonly distanceM: number
  readonly point: LngLat
  readonly bearingDeg: number
}

/**
 * Every pass of the route within `withinM` of the fix, in driving order, and
 * the closest point of the whole line (for when there is no pass at all).
 * Segments near the fix that follow one another are one pass, represented by
 * their closest point; a route that comes by the same spot twice gives two.
 */
function passesNear(route: TrackedRoute, at: LngLat, withinM: number): { passes: Pass[]; nearest: Pass | null } {
  const project = localProjector(at)
  const { line, alongM } = route
  const passes: Pass[] = []
  let nearest: Pass | null = null
  let open: Pass | null = null
  let previous = line[0] === undefined ? null : project(line[0])
  for (let i = 1; i < line.length && previous !== null; i++) {
    const next = project(line[i]!)
    const hit = pointToSegment([0, 0], previous, next)
    previous = next
    const a = line[i - 1]!
    const b = line[i]!
    const lengthM = alongM[i]! - alongM[i - 1]!
    const pass: Pass = {
      alongM: alongM[i - 1]! + hit.t * lengthM,
      distanceM: hit.distanceM,
      point: [a[0] + (b[0] - a[0]) * hit.t, a[1] + (b[1] - a[1]) * hit.t],
      bearingDeg: lengthM > 0 ? bearingDeg(a, b) : (open?.bearingDeg ?? 0),
    }
    if (nearest === null || pass.distanceM < nearest.distanceM) nearest = pass
    if (pass.distanceM <= withinM) {
      if (open === null || pass.distanceM < open.distanceM) open = pass
    } else if (open !== null) {
      passes.push(open)
      open = null
    }
  }
  if (open !== null) passes.push(open)
  if (nearest === null && line[0] !== undefined) {
    // A route of one point.
    nearest = { alongM: 0, distanceM: distanceM(at, line[0]), point: line[0], bearingDeg: 0 }
    if (nearest.distanceM <= withinM) passes.push(nearest)
  }
  return { passes, nearest }
}

/** Two passes whose distances from the fix differ by less than this are equally likely, in meters. */
const SAME_PASS_SLACK_M = 15

const closest = (passes: readonly Pass[]) => passes.reduce((best, p) => (p.distanceM < best.distanceM ? p : best))

function smoothedSpeed(previous: number | null, reading: number, weight: number): number {
  return previous === null ? reading : previous + weight * (reading - previous)
}

function usableHeading(heading: number | null): heading is number {
  return heading !== null && Number.isFinite(heading)
}

/**
 * Takes one fix into account and returns where the car is now.
 *
 * `state` is what the last call returned for THIS route, or null for the
 * first fix on it (a new drive, or a new route after a switch: see
 * `hintAlongM`). The rules:
 *
 * - **Poor fixes are ignored.** A fix whose accuracy is worse than
 *   `maxAccuracyM`, that is not a coordinate, or that is older than the last
 *   good one, changes nothing but a counter. With no state yet it gives null.
 * - **Snapping.** The fix is matched to a *pass* of the route: a stretch of it
 *   within `offRouteM` of the fix. Where the route comes by the same spot
 *   more than once, the pass that fits the progress so far is taken (the
 *   first one at or ahead of the last position that the car could have
 *   reached), not the globally nearest point.
 * - **No going back on noise.** A snap up to `backwardToleranceM` behind the
 *   last position keeps the position. A snap farther back, or farther ahead
 *   than `maxSpeedMps` allows, is believed after `jumpFixes` fixes in a row;
 *   once the car is known to be reversing, it is followed back at once.
 * - **Speed** is the device's when it gives one, otherwise the progress along
 *   the route (or, off it, the straight distance) between good fixes over the
 *   time between them; smoothed either way.
 * - **Heading** is the device's while the car moves, otherwise the route's
 *   own direction at the car.
 * - **Off route** only with patience: fixes farther than `offRouteM` from the
 *   whole line for `offRoutePatienceSec`, or `offRouteFixes` good fixes in a
 *   row. One stray fix is never enough.
 * - **Arrived** when the route left is `arrivalRadiusM` or less, or the fix is
 *   that close to the destination on the last stretch of the route.
 */
export function trackFix(
  state: TrackingState | null,
  route: TrackedRoute,
  fix: PositionFix,
  options: Partial<TrackingOptions> = {},
  /** With no state: about where along the route the car is known to be (a route taken up again). */
  hintAlongM?: number,
): TrackingState | null {
  const opts = resolve(options)
  if (!isUsableFix(fix, opts) || (state !== null && fix.timeMs <= state.fix.timeMs)) {
    return state === null ? null : { ...state, ignoredFixes: state.ignoredFixes + 1 }
  }
  const at: LngLat = [fix.lng, fix.lat]
  const { passes, nearest } = passesNear(route, at, opts.offRouteM)
  if (nearest === null) return state

  const dtSec = state === null ? 0 : (fix.timeMs - state.fix.timeMs) / 1000
  const last = state?.alongRouteM ?? (hintAlongM !== undefined && Number.isFinite(hintAlongM) ? hintAlongM : null)
  const reachM = Math.max(opts.minReachM, opts.maxSpeedMps * dtSec + opts.minReachM)

  let alongM: number
  let pass: Pass | null = null
  let jumpFixes = 0
  let reversing = state?.reversing ?? false
  if (passes.length === 0) {
    // Off the line: progress stays where it was.
    alongM = last ?? nearest.alongM
  } else if (last === null) {
    pass = closest(passes)
    alongM = pass.alongM
  } else if (state === null) {
    // A route taken up again: the pass nearest to where the car is known to be.
    pass = passes.reduce((best, p) => (Math.abs(p.alongM - last) < Math.abs(best.alongM - last) ? p : best))
    alongM = pass.alongM
  } else {
    const within = passes.filter((p) => p.alongM >= last - opts.backwardToleranceM && p.alongM <= last + reachM)
    if (within.length > 0) {
      // The pass the car is on: of those it could have reached, the first that is
      // about as near to the fix as any (at a crossing both are; the earlier one is next).
      const nearM = closest(within).distanceM + SAME_PASS_SLACK_M
      pass = within.find((p) => p.distanceM <= nearM)!
      if (pass.alongM >= last) reversing = false
      alongM = reversing ? pass.alongM : Math.max(last, pass.alongM)
    } else {
      // Only passes the car could not simply have driven to: behind it, or far ahead.
      const behind = passes.filter((p) => p.alongM < last)
      pass = behind.length > 0 ? behind.at(-1)! : passes[0]!
      jumpFixes = (state?.jumpFixes ?? 0) + 1
      if (reversing && pass.alongM < last) {
        alongM = pass.alongM
      } else if (jumpFixes >= opts.jumpFixes) {
        alongM = pass.alongM
        reversing = pass.alongM < last
        jumpFixes = 0
      } else {
        alongM = last
      }
    }
  }
  alongM = Math.min(route.lengthM, Math.max(0, alongM))

  const onLine = pass !== null
  const offFixes = onLine ? 0 : (state?.offFixes ?? 0) + 1
  const offSinceMs = onLine ? null : (state?.offSinceMs ?? fix.timeMs)
  const offRoute =
    !onLine &&
    offFixes >= 2 &&
    (offFixes >= opts.offRouteFixes || fix.timeMs - (offSinceMs ?? fix.timeMs) >= opts.offRoutePatienceSec * 1000)

  // Speed: the device's, else what the fixes say.
  let reading: number | null = null
  if (fix.speedMps !== null && Number.isFinite(fix.speedMps) && fix.speedMps >= 0) reading = fix.speedMps
  else if (state !== null && dtSec > 0) {
    const movedM = onLine && state.offFixes === 0 ? Math.abs(alongM - state.alongRouteM) : distanceM([state.fix.lng, state.fix.lat], at)
    reading = movedM / dtSec
  }
  const speedMps =
    reading === null ? (state?.speedMps ?? 0) : smoothedSpeed(state?.speedMps ?? null, Math.min(reading, opts.maxSpeedMps), opts.speedSmoothing)
  const stopped = speedMps < opts.stoppedSpeedMps
  const stoppedSinceMs = stopped ? (state?.stoppedSinceMs ?? fix.timeMs) : null

  // Heading: the device knows best while moving; standing still it wanders.
  let headingDeg = state?.headingDeg ?? pass?.bearingDeg ?? nearest.bearingDeg
  if (usableHeading(fix.headingDeg) && !stopped) headingDeg = ((fix.headingDeg % 360) + 360) % 360
  else if (pass !== null) headingDeg = pass.bearingDeg
  else if (state !== null && distanceM([state.fix.lng, state.fix.lat], at) > 5) headingDeg = bearingDeg([state.fix.lng, state.fix.lat], at)

  const remainingM = Math.max(0, route.lengthM - alongM)
  const end = route.line.at(-1)!
  const arrived =
    (onLine && remainingM <= opts.arrivalRadiusM) ||
    (remainingM <= opts.arrivalZoneM && distanceM(at, end) <= opts.arrivalRadiusM)

  let position: LngLat = at
  if (pass !== null) {
    // Held back by the no-going-back rule: draw the car where its progress is.
    position = pass.alongM === alongM ? pass.point : (pointAlong(route, alongM) ?? pass.point)
  }

  return {
    fix,
    position,
    alongRouteM: alongM,
    remainingM,
    speedMps,
    headingDeg,
    distanceFromRouteM: nearest.distanceM,
    offRoute,
    arrived,
    stoppedSinceMs,
    offSinceMs,
    offFixes,
    jumpFixes,
    reversing,
    ignoredFixes: state?.ignoredFixes ?? 0,
  }
}

/** The point `alongM` meters along a prepared route. Null for a route without points. */
function pointAlong(route: TrackedRoute, alongM: number): LngLat | null {
  const { line, alongM: along } = route
  if (line.length === 0) return null
  let i = 1
  while (i < line.length - 1 && along[i]! < alongM) i++
  const a = line[i - 1]!
  const b = line[i] ?? a
  const lengthM = (along[i] ?? 0) - along[i - 1]!
  const t = lengthM > 0 ? Math.min(1, Math.max(0, (alongM - along[i - 1]!) / lengthM)) : 0
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/**
 * The same car on another route (after a switch, or back on the route it was
 * on): its last good fix snapped onto `route` afresh, keeping its speed and
 * how long it has stood still. `hintAlongM` says about where along the route
 * it is when that is known, for a route that passes the same spot twice.
 */
export function retrack(
  state: TrackingState,
  route: TrackedRoute,
  options: Partial<TrackingOptions> = {},
  hintAlongM?: number,
): TrackingState {
  const fresh = trackFix(null, route, state.fix, options, hintAlongM)
  if (fresh === null) return state
  return { ...fresh, speedMps: state.speedMps, stoppedSinceMs: state.stoppedSinceMs, ignoredFixes: state.ignoredFixes }
}
