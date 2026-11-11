import { alongRouteM, distanceM, isValidLngLat, localProjector, pointAtDistance, pointToSegment } from './geo.ts'
import { SAME_ROUTE_TOLERANCE_M, sameRouteGeometry } from './select.ts'
import type { DistanceSpanM, LngLat, RouteCandidate } from './types.ts'

/**
 * Via-point selection for side-street probing (PLAN step 11a).
 *
 * Mapbox Directions returns at most three routes, so a faster cut-through that
 * is not among them is never seen. selectViaPoints picks a few points just off
 * the fastest route's surface-street stretches; asking for origin → via →
 * destination (step 11b) can then surface a parallel street Mapbox did not offer.
 *
 * Pure and deterministic: the same candidates and options always give the same
 * points, in the same order. No time, no randomness, no I/O.
 *
 * Gap: RouteCandidate carries no per-segment congestion or duration, so the
 * "slowest stretch" is approximated by the longest surface-street stretch.
 */

export interface ProbeOptions {
  /** Most via points returned. Each one costs a Directions request later, so keep it small. */
  readonly maxPoints: number
  /** Trips shorter than this (meters, fastest route) get no probes: there is no room for a cut-through to pay off. */
  readonly minTripM: number
  /**
   * No probing within this many meters of the origin or destination, measured
   * along the route for the targeted stretch and in a straight line for the
   * via point itself. A via point near an endpoint only bends the first or
   * last block, which is not a different route.
   */
  readonly endpointClearanceM: number
  /** A surface-street stretch (after the endpoint clearance is cut off) must be at least this long, in meters, to be probed. */
  readonly minStretchM: number
  /**
   * Perpendicular distances from the route tried for each side, in meters,
   * nearest first; the first one clear of every candidate is used. Far enough
   * to land on a parallel street, near enough that the detour can still win.
   */
  readonly offsetsM: readonly number[]
  /**
   * A via point closer than this (meters) to any candidate's line, the fastest
   * one included, is dropped: that route is already known, so the probe would
   * only repeat it.
   */
  readonly clearOfRoutesM: number
  /**
   * The route heading at a probe spot is taken over this many meters before
   * and after it, so a vertex or a kink in the line does not tilt the offset.
   */
  readonly headingWindowM: number
  /**
   * How far Mapbox may move the via point to snap it onto a road, in meters:
   * sent as the via's `radiuses` entry (the origin and destination stay
   * `unlimited`). No more than clearOfRoutesM, so a via can never snap back
   * onto a route already known; a via with no road this close comes back as
   * NoSegment instead of snapping onto a far road or a dead end.
   */
  readonly viaRadiusM: number
  /**
   * A probed route that passes within the same-route tolerance of every point
   * of a known route, that route sampled this often (meters), is the known
   * route plus a detour (a dead-end spur or a loop) and is dropped by
   * mergeProbeRoutes. Sampling between the vertices keeps a real cut-through
   * that leaves a long straight segment from being taken for one.
   */
  readonly coverSampleM: number
}

export const DEFAULT_PROBE_OPTIONS: ProbeOptions = {
  maxPoints: 3,
  minTripM: 3000,
  endpointClearanceM: 1000,
  minStretchM: 1500,
  offsetsM: [500, 800],
  clearOfRoutesM: 250,
  headingWindowM: 150,
  viaRadiusM: 250,
  coverSampleM: 10,
}

/** Which side of the base route, facing the direction of travel. */
export type ProbeSide = 'left' | 'right'

/** One place to route through, and why. */
export interface ViaPoint {
  readonly position: LngLat
  /** Plain-English line for logs and the UI. */
  readonly reason: string
  /** Id of the fastest candidate the point was placed off. */
  readonly baseRouteId: string
  /** The surface-street stretch of the base route it targets: meters from the route start, as in limitedAccessSpansM. */
  readonly targetSpanM: DistanceSpanM
  /** Where along the base route the point sits beside, in meters from the route start. */
  readonly atDistanceM: number
  readonly side: ProbeSide
  /** Perpendicular distance from the base route, in meters (one of options.offsetsM). */
  readonly offsetM: number
}

const usable = (c: RouteCandidate) =>
  Number.isFinite(c.durationSec) && c.geometry.length >= 2 && c.geometry.every(isValidLngLat)

/** Fastest usable candidate; ties go to the smaller id so the choice never depends on input order. */
function fastest(candidates: readonly RouteCandidate[]): RouteCandidate | null {
  let best: RouteCandidate | null = null
  for (const c of candidates) {
    if (!usable(c)) continue
    if (best === null || c.durationSec < best.durationSec || (c.durationSec === best.durationSec && c.id < best.id)) {
      best = c
    }
  }
  return best
}

/**
 * The parts of [fromM, toM] not covered by the limited-access spans. Unknown
 * road kinds (null spans) count as surface street: a wasted probe costs one
 * request, a skipped one can hide the fastest route. A span with a NaN bound,
 * or one that covers nothing (end at or before start), is ignored the same way:
 * kept, it would break the cursor or the sort.
 */
function surfaceStretches(spans: readonly DistanceSpanM[] | null, fromM: number, toM: number): DistanceSpanM[] {
  const out: DistanceSpanM[] = []
  let cursor = fromM
  const sorted = (spans ?? []).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])
  for (const [start, end] of sorted) {
    if (start > cursor) out.push([cursor, Math.min(start, toM)])
    cursor = Math.max(cursor, end)
    if (cursor >= toM) break
  }
  if (cursor < toM) out.push([cursor, toM])
  return out.filter(([a, b]) => b > a)
}

/** Shortest distance from a point to a polyline, in meters. A single-point line is that point. */
function distanceToLineM(point: LngLat, line: readonly LngLat[]): number {
  if (line.length === 0) return Infinity
  if (line.length === 1) return distanceM(point, line[0]!)
  const project = localProjector(point)
  const p = project(point)
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    best = Math.min(best, pointToSegment(p, project(line[i - 1]!), project(line[i]!)).distanceM)
  }
  return best
}

/** The point `offsetM` meters to one side of `p`, square to the heading. */
function offsetPoint(p: LngLat, headingDeg: number, side: ProbeSide, offsetM: number): LngLat {
  const [xPerDeg, yPerDeg] = localProjector(p)([p[0] + 1, p[1] + 1])
  const normal = ((headingDeg + (side === 'left' ? -90 : 90)) * Math.PI) / 180
  return [p[0] + (Math.sin(normal) * offsetM) / xPerDeg, p[1] + (Math.cos(normal) * offsetM) / yPerDeg]
}

const km = (m: number) => `${(m / 1000).toFixed(1)} km`

/**
 * Up to `options.maxPoints` via points off the fastest candidate's longest
 * surface-street stretches, best first. Empty for no usable candidate, a trip
 * under `minTripM`, or a route with no surface stretch of `minStretchM` away
 * from its ends (freeway-only trips).
 *
 * Each stretch is probed at its middle, on both sides. Points are ordered by
 * stretch (longest first) and, within a stretch, by side (the side farther
 * from the other candidates first, then left); the first side of every
 * stretch comes before any second side, so a small budget spreads out.
 */
export function selectViaPoints(
  candidates: readonly RouteCandidate[],
  options: ProbeOptions = DEFAULT_PROBE_OPTIONS,
): ViaPoint[] {
  const base = fastest(candidates)
  if (base === null || options.maxPoints <= 0) return []
  const lengthM = alongRouteM(base.geometry).at(-1)!
  if (lengthM < options.minTripM) return []
  const origin = base.geometry[0]!
  const destination = base.geometry.at(-1)!
  const clear = options.endpointClearanceM
  const stretches = surfaceStretches(base.limitedAccessSpansM, clear, lengthM - clear)
    .filter(([a, b]) => b - a >= options.minStretchM)
    .sort((x, y) => y[1] - y[0] - (x[1] - x[0]) || x[0] - y[0])
  // Only usable lines measure room: one NaN coordinate would make every room NaN and hide the side order.
  const others = candidates.filter((c) => c !== base && usable(c))
  const offsets = [...options.offsetsM].filter((o) => Number.isFinite(o) && o > 0).sort((a, b) => a - b)

  const rounds: ViaPoint[][] = [[], []]
  for (const span of stretches) {
    const midM = (span[0] + span[1]) / 2
    const here = pointAtDistance(base.geometry, midM)!
    const mid = here.point
    const before = pointAtDistance(base.geometry, midM - options.headingWindowM)!.point
    const after = pointAtDistance(base.geometry, midM + options.headingWindowM)!.point
    // A chord much shorter than the window means a hairpin there: use the segment's own heading.
    const heading =
      distanceM(before, after) < options.headingWindowM
        ? here.bearingDeg
        : Math.atan2((after[0] - before[0]) * Math.cos((mid[1] * Math.PI) / 180), after[1] - before[1]) *
          (180 / Math.PI)
    const found: { point: ViaPoint; roomM: number }[] = []
    for (const side of ['left', 'right'] as const) {
      for (const offsetM of offsets) {
        const position = offsetPoint(mid, heading, side, offsetM)
        if (!isValidLngLat(position)) continue
        if (distanceM(position, origin) < clear || distanceM(position, destination) < clear) continue
        if (candidates.some((c) => distanceToLineM(position, c.geometry) < options.clearOfRoutesM)) continue
        const roomM = Math.min(...others.map((c) => distanceToLineM(position, c.geometry)))
        const reason =
          `${offsetM} m ${side} of the fastest route's ${km(span[1] - span[0])} surface-street stretch ` +
          `(${km(span[0])} to ${km(span[1])} from the start)`
        found.push({
          point: { position, reason, baseRouteId: base.id, targetSpanM: span, atDistanceM: midM, side, offsetM },
          roomM,
        })
        break
      }
    }
    // More room first; equal (or unknown) room keeps left before right.
    found.sort((a, b) => (b.roomM > a.roomM ? 1 : b.roomM < a.roomM ? -1 : 0)).forEach(({ point }, i) => rounds[i]!.push(point))
  }
  return rounds.flat().slice(0, options.maxPoints)
}

/**
 * How many probe requests a plan may make, and when (PLAN step 11b). Each
 * probe is one Directions request on top of the plan's own, so the budget is
 * small and fixed.
 */
export interface ProbeBudget {
  /**
   * Most probe requests per plan (one trip, from the moment its main routes
   * arrive until a pin moves).
   * A fraction is rounded down; under 1, or not a finite number, turns probing
   * off. Never more than ProbeOptions.maxPoints.
   */
  readonly requestsPerPlan: number
  /**
   * How long the main routes must stay on screen before the probes go out, in
   * milliseconds. A pin moved within this time cancels them, so a run of pin
   * moves costs no probes until it stops.
   */
  readonly debounceMs: number
}

export const DEFAULT_PROBE_BUDGET: ProbeBudget = {
  requestsPerPlan: 2,
  debounceMs: 800,
}

/**
 * The via points to probe for one plan: selectViaPoints, cut to the budget.
 * Empty when the budget is off, there is no usable route, or the trip has
 * nothing to probe (shorter than minTripM, or freeway-only: no surface-street
 * stretch of minStretchM away from its ends). Pure: the same routes give the
 * same points in the same order.
 */
export function planProbes(
  candidates: readonly RouteCandidate[],
  budget: ProbeBudget = DEFAULT_PROBE_BUDGET,
  options: ProbeOptions = DEFAULT_PROBE_OPTIONS,
): ViaPoint[] {
  const allowed = Number.isFinite(budget.requestsPerPlan) ? Math.floor(budget.requestsPerPlan) : 0
  const maxPoints = Math.min(allowed, Number.isFinite(options.maxPoints) ? options.maxPoints : 0)
  if (maxPoints <= 0) return []
  return selectViaPoints(candidates, { ...options, maxPoints })
}

/**
 * The line sampled every `sampleM` meters along it, its own vertices
 * included. A step that is not a positive number gives the vertices only.
 */
function sampled(line: readonly LngLat[], sampleM: number): LngLat[] {
  if (!(Number.isFinite(sampleM) && sampleM > 0)) return [...line]
  const out: LngLat[] = []
  for (let i = 0; i < line.length; i++) {
    const p = line[i]!
    const prev = line[i - 1]
    if (prev !== undefined) {
      const pieces = Math.ceil(distanceM(prev, p) / sampleM)
      for (let k = 1; k < pieces; k++) {
        out.push([prev[0] + ((p[0] - prev[0]) * k) / pieces, prev[1] + ((p[1] - prev[1]) * k) / pieces])
      }
    }
    out.push(p)
  }
  return out
}

/**
 * True when `probe` passes within `toleranceM` of every point of `known`,
 * `known` sampled every `sampleM` meters: the probe drives all of the known
 * route and something more (a dead-end spur, a loop to the via), so it can
 * only be slower. One-way on purpose: the probe's own extra roads are
 * allowed. Sampling between vertices matters: a cut-through that leaves a
 * long straight segment of the known route (no vertices of its own there)
 * would otherwise pass for covering it.
 */
export function coversRoute(
  probe: readonly LngLat[],
  known: readonly LngLat[],
  toleranceM: number = SAME_ROUTE_TOLERANCE_M,
  sampleM: number = DEFAULT_PROBE_OPTIONS.coverSampleM,
): boolean {
  if (probe.length < 2 || known.length < 2) return false
  const project = localProjector(known[0]!)
  const line = probe.map(project)
  const segments = line.length - 1
  // Consecutive samples are usually beside the same segment: each search starts at the last hit.
  let last = 0
  return sampled(known, sampleM).every((point) => {
    const p = project(point)
    for (let k = 0; k < segments; k++) {
      const i = (last + k) % segments
      if (pointToSegment(p, line[i]!, line[i + 1]!).distanceM <= toleranceM) {
        last = i
        return true
      }
    }
    return false
  })
}

/**
 * The provider's routes with the probed ones added (PLAN step 11b). A probed
 * route is tagged `source: 'probe'` and kept only when it is a new path. One
 * that follows the same roads as a route already in the set (sameRouteGeometry
 * in select.ts; ids are not compared) is dropped: that is what happens when
 * Mapbox snaps a via point back onto a known route. So is one that covers a
 * route already in the set (coversRoute): that route plus a dead-end spur or
 * a loop out to the via, never faster and not a side street. Probes are
 * deduplicated among themselves too, the earlier one kept, and a probed route
 * with no usable travel time or line is dropped. The provider's routes come
 * first, as they came. Ranking is left to rankRoutes, unchanged, so a probed
 * route wins only on ETA.
 */
export function mergeProbeRoutes(
  candidates: readonly RouteCandidate[],
  probed: readonly RouteCandidate[],
  toleranceM: number = SAME_ROUTE_TOLERANCE_M,
  coverSampleM: number = DEFAULT_PROBE_OPTIONS.coverSampleM,
): RouteCandidate[] {
  const merged = [...candidates]
  for (const route of probed) {
    if (!usable(route)) continue
    if (merged.some((known) => sameRouteGeometry(known.geometry, route.geometry, toleranceM))) continue
    if (merged.some((known) => usable(known) && coversRoute(route.geometry, known.geometry, toleranceM, coverSampleM))) continue
    merged.push({ ...route, source: 'probe' })
  }
  return merged
}

/**
 * The line to tell the user when a probed route is recommended (PLAN step
 * 11b), from rankRoutes' order. Null when the top route is not a probed one,
 * or there is no route from the provider to compare it with. The saving is
 * against the best route the provider offered itself, in whole minutes
 * (rounded); under a minute says so, and a probe that is no faster (it won on
 * the signal tie-break, or on distance) is not called faster, and has fewer
 * signals only when both counts are full and known.
 */
export function sideStreetNotice(ranked: readonly { readonly route: RouteCandidate }[]): string | null {
  const top = ranked[0]?.route
  if (top === undefined || top.source !== 'probe') return null
  const known = ranked.find((r) => r.route.source !== 'probe')?.route
  if (known === undefined) return null
  const savedSec = known.durationSec - top.durationSec
  if (!Number.isFinite(savedSec)) return null
  if (savedSec <= 0) {
    // Fewer signals is said only when both counts are whole and known (unknown is never zero).
    const full = (r: RouteCandidate) => (r.signalCoverage === 'full' && r.signalCount !== null && Number.isFinite(r.signalCount) ? r.signalCount : null)
    const topSignals = full(top)
    const knownSignals = full(known)
    return topSignals !== null && knownSignals !== null && topSignals < knownSignals
      ? 'Route via side streets recommended: about the same time, fewer signals.'
      : 'Route via side streets recommended: about the same time.'
  }
  const minutes = Math.round(savedSec / 60)
  return minutes < 1
    ? 'Faster route found via side streets, saves under a minute.'
    : `Faster route found via side streets, saves ${minutes} min.`
}
