import { alongRouteM, distanceM, isValidLngLat, localProjector, pointAtDistance, pointToSegment } from './geo.ts'
import { findCurrentRoute, type RerouteDecision, type RerouteOptions } from './reroute.ts'
import { SAME_ROUTE_TOLERANCE_M, sameRouteGeometry } from './select.ts'
import type { CongestionLevel, DistanceSpanM, LngLat, RouteCandidate } from './types.ts'

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
 * Where the fastest route carries live traffic (RouteCandidate.segmentTraffic),
 * the probes aim at its congested stretches: that is where a parallel street
 * can save time. Without it, the longest surface-street stretch stands in for
 * the slowest.
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
  /**
   * Congestion levels that count as a jam worth going round. A segment at any
   * other level, 'unknown' included, is not congested: unknown is never taken
   * for a jam.
   */
  readonly congestedLevels: readonly CongestionLevel[]
  /**
   * Congested runs of the route this close together or closer, in meters, are
   * one jam: real annotations flicker between heavy and moderate inside a queue.
   */
  readonly congestionGapM: number
  /**
   * A surface-street stretch is aimed at by the data only when at least this
   * much of it, in meters, is congested (congested segments only: the gaps
   * joined by congestionGapM do not count). Below it, the stretch is ordered by
   * length like a route with no traffic data.
   */
  readonly minCongestedM: number
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
  congestedLevels: ['heavy', 'severe'],
  congestionGapM: 200,
  minCongestedM: 300,
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
  /**
   * The jam the point is aimed at, inside targetSpanM, in meters from the
   * route start: the longest congested run of the stretch. Null when the
   * point was placed without traffic data (the middle of the stretch).
   */
  readonly congestedSpanM: DistanceSpanM | null
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

/**
 * The congested runs of a route, as [startM, endM] along its geometry, in
 * driving order: segments at one of `levels`, with runs `gapM` or less apart
 * joined into one. Empty when the route has no congestion list, or one that
 * does not have exactly one entry per segment (it would misplace the jams).
 */
function congestedRuns(
  route: RouteCandidate,
  along: readonly number[],
  levels: readonly CongestionLevel[],
  gapM: number,
): DistanceSpanM[] {
  const congestion = route.segmentTraffic?.congestion
  if (congestion == null || congestion.length !== route.geometry.length - 1) return []
  const gap = Number.isFinite(gapM) && gapM > 0 ? gapM : 0
  const runs: DistanceSpanM[] = []
  for (let i = 0; i < congestion.length; i++) {
    // Unknown is never a jam, even when listed.
    const level = congestion[i]!
    if (level === 'unknown' || !levels.includes(level)) continue
    const start = along[i]!
    const end = along[i + 1]!
    const last = runs.at(-1)
    if (last !== undefined && start - last[1] <= gap) runs[runs.length - 1] = [last[0], end]
    else runs.push([start, end])
  }
  return runs.filter(([a, b]) => b > a)
}

/** The parts of `runs` inside `span`, clipped to it. */
function within(runs: readonly DistanceSpanM[], [from, to]: DistanceSpanM): DistanceSpanM[] {
  return runs.map(([a, b]): DistanceSpanM => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a)
}

const spanLength = ([a, b]: DistanceSpanM) => b - a

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
 * Up to `options.maxPoints` via points off the fastest candidate's slowest
 * surface-street stretches, best first. Empty for no usable candidate, a trip
 * under `minTripM`, or a route with no surface stretch of `minStretchM` away
 * from its ends (freeway-only trips).
 *
 * Stretches with at least `minCongestedM` of congestion (segments at one of
 * `congestedLevels`, runs within `congestionGapM` joined) come first, the most
 * congested first, and each is probed at the middle of its longest jam. The
 * rest follow, longest first, each probed at its middle: with no traffic data
 * at all that is the whole order, the longest stretch standing in for the
 * slowest. Every stretch is probed on both sides. Within a stretch the side
 * farther from the other candidates comes first, then left; the first side of
 * every stretch comes before any second side, so a small budget spreads out.
 *
 * `base`, when given and usable, is the route to probe beside instead of the
 * fastest (a drive probes beside the route being driven: see checkProbes).
 * Every candidate, `base` included, still counts as a known route to keep
 * clear of.
 */
export function selectViaPoints(
  candidates: readonly RouteCandidate[],
  options: ProbeOptions = DEFAULT_PROBE_OPTIONS,
  base: RouteCandidate | null = null,
): ViaPoint[] {
  if (base !== null && !usable(base)) base = null
  base ??= fastest(candidates)
  if (base === null || options.maxPoints <= 0) return []
  const along = alongRouteM(base.geometry)
  const lengthM = along.at(-1)!
  if (lengthM < options.minTripM) return []
  const origin = base.geometry[0]!
  const destination = base.geometry.at(-1)!
  const clear = options.endpointClearanceM
  // Jams (runs joined across short gaps) are what is aimed at; only congested road itself is counted.
  const runs = congestedRuns(base, along, options.congestedLevels, options.congestionGapM)
  const congestedOnly = congestedRuns(base, along, options.congestedLevels, 0)
  const stretches = surfaceStretches(base.limitedAccessSpansM, clear, lengthM - clear)
    .filter(([a, b]) => b - a >= options.minStretchM)
    .map((span) => {
      const jams = within(runs, span)
      const congestedM = within(congestedOnly, span).reduce((sum, run) => sum + spanLength(run), 0)
      // The longest jam; equal ones go to the earlier, so the choice is deterministic.
      const jam =
        jams.length > 0 && congestedM >= options.minCongestedM
          ? jams.reduce((x, y) => (spanLength(y) > spanLength(x) ? y : x))
          : null
      return { span, jam, congestedM: jam === null ? 0 : congestedM }
    })
    .sort((x, y) => y.congestedM - x.congestedM || spanLength(y.span) - spanLength(x.span) || x.span[0] - y.span[0])
  // Only usable lines measure room: one NaN coordinate would make every room NaN and hide the side order.
  const others = candidates.filter((c) => c !== base && usable(c))
  const known = candidates.includes(base) ? candidates : [...candidates, base]
  const offsets = [...options.offsetsM].filter((o) => Number.isFinite(o) && o > 0).sort((a, b) => a - b)

  const rounds: ViaPoint[][] = [[], []]
  for (const { span, jam } of stretches) {
    const aim = jam ?? span
    const midM = (aim[0] + aim[1]) / 2
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
        if (known.some((c) => distanceToLineM(position, c.geometry) < options.clearOfRoutesM)) continue
        const roomM = Math.min(...others.map((c) => distanceToLineM(position, c.geometry)))
        const reason =
          jam === null
            ? `${offsetM} m ${side} of the fastest route's ${km(span[1] - span[0])} surface-street stretch ` +
              `(${km(span[0])} to ${km(span[1])} from the start)`
            : `${offsetM} m ${side} of the fastest route's ${km(jam[1] - jam[0])} jam on surface street ` +
              `(${km(jam[0])} to ${km(jam[1])} from the start)`
        found.push({
          point: {
            position,
            reason,
            baseRouteId: base.id,
            targetSpanM: span,
            atDistanceM: midM,
            side,
            offsetM,
            congestedSpanM: jam,
          },
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

/**
 * How many side-street probes a drive may make (PLAN step 11c, #5). Probes
 * share the drive's request budget (LiveOptions.maxRequests, the simulated
 * drive's DriveSettings.maxRequests): they never take a request an ordinary
 * check or its path check (baselineProbe) needs.
 */
export interface DriveProbeBudget {
  /** Most probe requests per check. A fraction is rounded down; under 1, or not a finite number, turns probing off during a drive. */
  readonly requestsPerCheck: number
  /** Most probe requests per drive, so that most of the request budget stays for the checks themselves. */
  readonly requestsPerDrive: number
}

export const DEFAULT_DRIVE_PROBE_BUDGET: DriveProbeBudget = {
  requestsPerCheck: 1,
  requestsPerDrive: 20,
}

const whole = (v: number | undefined, fallback: number) =>
  v === undefined ? fallback : Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0

/**
 * How many probe requests the check being sent may make. `requestsUsed`
 * counts the drive's requests so far, this check included; `probesUsed` the
 * probes among them. One request is always left over for the check's own
 * path check (baselineProbe), whether it turns out to be needed or not, so a
 * probe never takes the request the engine needs to judge the route being
 * driven. Zero once the per-drive cap or the budget is reached.
 */
export function checkProbeAllowance(
  used: { readonly requestsUsed: number; readonly probesUsed: number },
  maxRequests: number,
  budget: Partial<DriveProbeBudget> = {},
): number {
  const perCheck = whole(budget.requestsPerCheck, DEFAULT_DRIVE_PROBE_BUDGET.requestsPerCheck)
  const perDrive = whole(budget.requestsPerDrive, DEFAULT_DRIVE_PROBE_BUDGET.requestsPerDrive)
  if (![used.requestsUsed, used.probesUsed, maxRequests].every(Number.isFinite)) return 0
  const room = Math.floor(maxRequests) - used.requestsUsed - 1
  return Math.max(0, Math.min(perCheck, perDrive - used.probesUsed, room))
}

/** What a drive remembers about its probes between checks. Plain data: keep it, pass it back, never edit it. */
export interface CheckProbeMemory {
  /** Probe requests made so far on this drive. */
  readonly used: number
  /** Checks that made a probe so far: which of a check's via points comes first next time (they take turns). */
  readonly round: number
  /**
   * The via point of the probed route the reroute engine is confirming (or
   * holding through its cooldown): the next check asks through it first, so
   * the route it found can come back and be confirmed. Null when there is none.
   */
  readonly keep: LngLat | null
}

export const INITIAL_CHECK_PROBES: CheckProbeMemory = { used: 0, round: 0, keep: null }

export interface CheckProbeInput {
  /** The route being driven, and how far along it the check was asked from. */
  readonly route: Pick<RouteCandidate, 'geometry'>
  readonly alongM: number
  /** The check's fresh routes, from the car. */
  readonly fresh: readonly RouteCandidate[]
  /** The answer to the check's request for the current path itself, when one was made (see RerouteObservation.baseline). */
  readonly baseline?: readonly RouteCandidate[] | null
  readonly memory: CheckProbeMemory
  /** How many probe requests this check may make (checkProbeAllowance). */
  readonly allowed: number
  /** The engine's thresholds in use, so the current route is found among the fresh ones as the engine finds it. */
  readonly rerouteOptions?: Partial<RerouteOptions>
}

/** Where along a line the point nearest `p` is, in meters from the line's start. */
function nearestAlongM(line: readonly LngLat[], p: LngLat): number {
  const project = localProjector(p)
  const along = alongRouteM(line)
  let best = { distanceM: Infinity, atM: 0 }
  for (let i = 1; i < line.length; i++) {
    const hit = pointToSegment([0, 0], project(line[i - 1]!), project(line[i]!))
    if (hit.distanceM < best.distanceM) best = { distanceM: hit.distanceM, atM: along[i - 1]! + hit.t * (along[i]! - along[i - 1]!) }
  }
  return best.atM
}

/**
 * The via points to probe on one check of a drive (PLAN step 11c, #5), at
 * most `allowed` of them. The points are selectViaPoints' (the same rules and
 * options as the plan screen's), from the car: beside the route being driven
 * as this check found it (among the fresh routes, or the answer for the
 * current path itself). None when it was not found: the engine then compares
 * nothing (route-unconfirmed), and a probe might come back as the current
 * path and stand in for it. Every fresh route, and that answer, is a known
 * route to keep clear of.
 *
 * - The via of a probed route the engine is confirming (memory.keep) comes
 *   first, while it is still beside the road ahead (not within the endpoint
 *   clearance of the car or the destination, along the route or in a straight
 *   line) and clear of every known route. Confirmation needs the same route
 *   on consecutive checks; the points alone would move with the car.
 * - The other points take turns, check by check (memory.round), so a small
 *   budget tries every side of every stretch in time. A point within
 *   clearOfRoutesM of the kept via is the same probe and is skipped.
 *
 * Empty when nothing may be asked, the current route was not found, or there is
 * nothing to probe (under minTripM left, or freeway only). Pure: the same
 * input gives the same points in the same order.
 */
export function checkProbes(input: CheckProbeInput, options: ProbeOptions = DEFAULT_PROBE_OPTIONS): LngLat[] {
  const allowed = whole(input.allowed, 0)
  if (allowed <= 0) return []
  const known = [...input.fresh, ...(input.baseline ?? [])].filter(usable)
  if (known.length === 0) return []
  // Without the current route's own fresh line (among the fresh routes, or the path check's
  // answer) the engine compares nothing this check (route-unconfirmed), and a probe could snap
  // back onto the current path and stand in for it. So no probe then.
  const base = findCurrentRoute(input.route, input.alongM, known, input.rerouteOptions)
  if (base === null) return []
  const points = selectViaPoints(known, options, base).map((p) => p.position)

  const out: LngLat[] = []
  const keep = input.memory.keep
  if (keep !== null && isValidLngLat(keep)) {
    const lengthM = alongRouteM(base.geometry).at(-1) ?? 0
    const atM = nearestAlongM(base.geometry, keep)
    const clear = options.endpointClearanceM
    const beside =
      lengthM >= options.minTripM &&
      atM >= clear &&
      atM <= lengthM - clear &&
      distanceM(keep, base.geometry[0]!) >= clear &&
      distanceM(keep, base.geometry.at(-1)!) >= clear &&
      !known.some((c) => distanceToLineM(keep, c.geometry) < options.clearOfRoutesM)
    if (beside) out.push(keep)
  }
  const kept = out[0]
  const others = points.filter((p) => kept === undefined || distanceM(p, kept) >= options.clearOfRoutesM)
  const start = others.length === 0 ? 0 : whole(input.memory.round, 0) % others.length
  const turn = [...others.slice(start), ...others.slice(0, start)]
  return [...out, ...turn].slice(0, allowed)
}

/**
 * The check's fresh routes with its probed routes added: a probed route is
 * kept only when it is new against the fresh routes AND the answer for the
 * current path itself (mergeProbeRoutes' rules: not the same path, and not a
 * known route plus a dead-end spur), tagged `source: 'probe'`. The fresh
 * routes come first, as they came, so the reroute engine's off-route test
 * still reads the provider's own first route. That answer is not added: it is
 * passed to the engine on its own, as before.
 */
export function mergeCheckProbes(
  fresh: readonly RouteCandidate[],
  baseline: readonly RouteCandidate[] | null | undefined,
  probed: readonly RouteCandidate[],
): RouteCandidate[] {
  const known = [...fresh, ...(baseline ?? [])]
  const added = mergeProbeRoutes(known, probed).slice(known.length)
  return [...fresh, ...added]
}

/**
 * The probe memory after a check has been decided. `asked`: the probe
 * requests the check made; `routes`: the routes the engine was given (null
 * for a failed check). The kept via is the one of the probed route the engine
 * is now confirming or holding (a 'stay' with a pending alternative that is a
 * probed route carrying its via); a failed check keeps it, as the engine
 * keeps a confirmation through a failed poll; anything else, a switch
 * included, drops it.
 */
export function rememberCheckProbes(
  memory: CheckProbeMemory,
  asked: number,
  decision: Pick<RerouteDecision, 'action' | 'considered' | 'nextState'>,
  routes: readonly RouteCandidate[] | null,
): CheckProbeMemory {
  const made = whole(asked, 0)
  const counted: CheckProbeMemory = { ...memory, used: memory.used + made, round: made > 0 ? memory.round + 1 : memory.round }
  if (routes === null) return counted
  const pending = decision.action === 'stay' && decision.nextState.pending !== null ? decision.considered : null
  const route = pending === null ? undefined : routes.find((r) => r.id === pending.routeId)
  const keep = route?.source === 'probe' && route.via !== undefined && isValidLngLat(route.via) ? route.via : null
  return { ...counted, keep }
}
