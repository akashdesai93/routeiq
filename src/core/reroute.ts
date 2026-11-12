import {
  alongRouteM,
  isValidLngLat,
  lineFrom,
  localProjector,
  pointAtDistance,
  pointToSegment,
  segmentGrid,
  type MatchMeter,
  type SegmentGrid,
  type XY,
} from './geo.ts'
import { DEFAULT_ETA_TIE_WINDOW_SEC, rankRoutes } from './rank.ts'
import { SAME_ROUTE_TOLERANCE_M } from './select.ts'
import type { DistanceSpanM, LngLat, Maneuver, RouteCandidate } from './types.ts'

/**
 * The switching brain: given what a poll just returned, should the driver stay
 * on the route being driven or change to another one, with no tap.
 *
 * A pure, deterministic state machine. Time is an input (nowSec), never read
 * from a clock; the state is plain data that the caller keeps between polls.
 * The same state, observation and options always give the same decision, so a
 * Swift port or a native wrapper can run it as it is.
 */

/** Every threshold of the reroute rules, in one place. See DEFAULT_REROUTE_OPTIONS for the values. */
export interface RerouteOptions {
  /** An alternative must beat the current route's fresh ETA by at least this many seconds. */
  readonly minSavingSec: number
  /**
   * ...and by at least this share of the time left on the current route
   * (0.05 is 5%). The two together: 2 minutes gained on a 90 minute leg is
   * under 5% and not worth a change, and 5% of a 4 minute leg is 12 seconds
   * of noise, which the seconds floor rejects.
   */
  readonly minSavingFraction: number
  /** The same alternative has to win this many polls in a row before a switch. 1 switches on the first. */
  readonly confirmPolls: number
  /** After a switch, no other switch for this many seconds. */
  readonly cooldownSec: number
  /** A route left less than this many seconds ago is only taken again for a bigger saving (returnSavingFactor). */
  readonly noReturnSec: number
  /** Going back to a route left recently needs this many times the minimum saving, seconds and share both. */
  readonly returnSavingFactor: number
  /** Never switch when the alternative turns off closer than this, in meters. */
  readonly minLeadDistanceM: number
  /** ...or closer than this many seconds of driving at the current speed. The larger of the two distances applies. */
  readonly minLeadTimeSec: number
  /** On a freeway the turn-off is an exit that needs lane changes: it must be at least this far ahead, in meters. */
  readonly freewayLeadDistanceM: number
  /**
   * When no fresh route is the rest of the current one, the current route is
   * kept: a route that is merely not among the provider's best three is still
   * a good road. It is only given up after the provider, asked for the
   * current path itself (RerouteObservation.baseline), has answered "no
   * route that way" this many polls in a row: then the road ahead cannot be
   * routed at all (a closure), and the best fresh route is taken.
   */
  readonly routeLostPolls: number
  /**
   * ...and those answers count only while they are this recent, in seconds: a
   * "no route" answer from longer ago than this is about a road the driver
   * may long since have passed, and is dropped from the count (#68). 0 counts
   * only answers from the same second: no closure switch, which is the safe side.
   */
  readonly routeLostWindowSec: number
  /** The driver is off the current route when the fresh routes start farther than this from its line, in meters. */
  readonly offRouteM: number
  /**
   * How close a point must be to the current route's line to be on it, in
   * meters (see SAME_ROUTE_TOLERANCE_M). Used to find where an alternative
   * turns off and which maneuvers it shares. Whether a whole fresh route IS
   * the current one is decided by the match* thresholds below.
   */
  readonly sameRouteToleranceM: number
  /**
   * Matching a fresh route to the rest of the current one (findCurrentRoute):
   * how far apart the two lines may run and still be together, in meters.
   * Wider than sameRouteToleranceM because the same road comes back drawn a
   * little differently: a corner cut 14 m inside the old one, the other lane
   * group of a freeway (both measured on real answers, see the README).
   */
  readonly matchToleranceM: number
  /**
   * ...and the share of each line's length that must run within that distance
   * of the other (0.95 is 95%), measured on the shorter of the two.
   */
  readonly matchMinOverlap: number
  /**
   * ...and no single stretch apart may be longer than this, in meters; nor
   * may the two lengths differ by more. This is what keeps a different road
   * for a kilometer from hiding inside a long route's allowance.
   */
  readonly matchMaxGapM: number
  /**
   * ...and no point of either line may run farther than this from the other,
   * in meters. The stretches apart that the rules above allow are the way the
   * same road comes back drawn (the farthest measured: 39 m, the other lane
   * group at a freeway exit); a street one block over runs a hundred meters
   * or more away, and is another route however short the stretch (#41).
   */
  readonly matchMaxDivergenceM: number
  /**
   * The first meters after the query point are not compared: the provider
   * snaps the start to a road its own way (the other side of a divided road,
   * a parallel street), and the two lines join a moment later.
   */
  readonly matchIgnoreStartM: number
  /**
   * Where the fresh route starts is looked for on the first this many meters
   * of the current path (which begins `offRouteM` behind the driver), and on
   * the rest of it only when nothing there is within `matchToleranceM`. A route that
   * crosses itself (a cloverleaf) passes the driver's spot again later, and
   * the nearest point of the whole path can be that later pass (#74). It must
   * be shorter than the shortest loop back to the same spot.
   */
  readonly matchStartSearchM: number
  /**
   * Asking for the current path's own travel time (baselineProbe): a via
   * point at least every this many meters along each stretch of it that the
   * fresh routes do not share.
   */
  readonly baselineViaSpacingM: number
  /**
   * ...and no more than this many via points in one request. Six is as far
   * as Mapbox goes with traffic: measured Nov 2026, a driving-traffic answer
   * for more than 8 coordinates comes back with `duration_typical` null, and
   * a time without it is not compared (requireTypicalDuration).
   */
  readonly baselineMaxViaPoints: number
  /**
   * An alternative is "going back" to a route left recently when at least
   * this share of its own part (the part not shared with the current route)
   * runs along that route.
   */
  readonly returnOverlapFraction: number
  /**
   * Compare ETAs only when both routes carry a typical duration. The
   * driving-traffic profile always sends one, so a route without it did not
   * come with traffic data and its time is not a like-for-like ETA.
   */
  readonly requireTypicalDuration: boolean
  /** Passed on to rankRoutes: ETAs this close are a tie that signals may break. */
  readonly etaTieWindowSec: number
}

/** The one place the defaults are set. Pass any subset to decideReroute to override. */
export const DEFAULT_REROUTE_OPTIONS: RerouteOptions = {
  minSavingSec: 120,
  minSavingFraction: 0.05,
  confirmPolls: 2,
  cooldownSec: 300,
  noReturnSec: 600,
  returnSavingFactor: 2,
  minLeadDistanceM: 400,
  minLeadTimeSec: 20,
  freewayLeadDistanceM: 1200,
  routeLostPolls: 3,
  routeLostWindowSec: 900,
  offRouteM: 50,
  sameRouteToleranceM: SAME_ROUTE_TOLERANCE_M,
  matchToleranceM: 20,
  matchMinOverlap: 0.95,
  matchMaxGapM: 400,
  matchMaxDivergenceM: 50,
  matchIgnoreStartM: 150,
  matchStartSearchM: 200,
  baselineViaSpacingM: 3000,
  baselineMaxViaPoints: 6,
  returnOverlapFraction: 0.5,
  requireTypicalDuration: true,
  etaTieWindowSec: DEFAULT_ETA_TIE_WINDOW_SEC,
}

/** What the engine remembers between polls. Plain data: keep it, pass it back, never edit it. */
export interface RerouteState {
  /**
   * The alternative that won the last poll and how many polls in a row it
   * has won. Remembered by its path, because route ids change from poll to
   * poll. Null when no alternative won the last poll.
   */
  readonly pending: { readonly geometry: readonly LngLat[]; readonly polls: number } | null
  /** When the last switch was made (the nowSec of that poll). Null before the first. */
  readonly lastSwitchAtSec: number | null
  /** The routes left by a switch, each as the path that was still ahead at that moment. Old entries are dropped. */
  readonly abandoned: readonly { readonly geometry: readonly LngLat[]; readonly atSec: number }[]
  /** Polls in a row that failed (no answer). A failed poll changes nothing else. */
  readonly failedPolls: number
  /**
   * Polls in a row in which the provider was asked for the current path
   * itself and found no route that way (see RerouteOptions.routeLostPolls).
   * A poll that could not ask leaves it as it is; one that finds the current
   * route, or is answered with any route at all, sets it back to 0.
   * Answers older than `routeLostWindowSec` no longer count (see lostAtSec):
   * this is always lostAtSec's length.
   */
  readonly lostPolls: number
  /**
   * When each of those "no route" answers came (the nowSec of its poll),
   * oldest first. This is what the engine counts: an answer drops out once it
   * is more than `routeLostWindowSec` old (#68).
   */
  readonly lostAtSec: readonly number[]
  /**
   * Routes the driver turned down ("Keep previous route"), each as the path
   * that was ahead at that moment and the time until which it is not to be
   * offered again (see declineRoute). Left out or empty when there are none.
   */
  readonly declined?: readonly { readonly geometry: readonly LngLat[]; readonly untilSec: number }[]
}

/** The state to start a drive with. */
export const INITIAL_REROUTE_STATE: RerouteState = {
  pending: null,
  lastSwitchAtSec: null,
  abandoned: [],
  failedPolls: 0,
  lostPolls: 0,
  lostAtSec: [],
}

/** What one poll found. */
export interface RerouteObservation {
  /** The time of the poll, in seconds on any clock that only moves forward. Injected, never read here. */
  readonly nowSec: number
  /** The route being driven. */
  readonly route: Pick<RouteCandidate, 'geometry' | 'maneuvers' | 'limitedAccessSpansM'>
  /**
   * How far along `route` the driver was when the directions query was sent,
   * in meters from its start (see alongRouteM). It has to be the place the
   * candidates start from. A position taken a moment later is forgiven: the
   * candidates then start a little behind the driver, which the matching
   * allows for (up to `offRouteM` exactly, and beyond that within what
   * `matchMaxGapM` lets two lengths differ).
   */
  readonly positionAlongM: number
  /** The driver's speed, in meters per second. */
  readonly speedMps: number
  /**
   * The routes a directions query FROM the driver's position just returned,
   * with signal counts when they are known. Null when the poll failed
   * (network error, rate limit): nothing is known this time.
   */
  readonly candidates: readonly RouteCandidate[] | null
  /**
   * How far the driver is from the current route's line, in meters, when the
   * caller measures it (GPS). Left out, it is taken from where the fresh
   * routes start, which is the driver's position snapped to a road.
   */
  readonly offRouteM?: number
  /**
   * What the provider answered when asked for the CURRENT path itself (a
   * request through the via points of baselineProbe), for a poll in which
   * none of `candidates` is the rest of the current route. It gives the
   * current route a fresh travel time to compare against, when the answer
   * is the current path (it is matched like any fresh route) and carries a
   * typical duration. Left out or null: not asked, or the request failed
   * (nothing is known). An empty list: asked, and the provider found no
   * route that way at all, which is the one thing that counts against the
   * road ahead (routeLostPolls).
   *
   * Not quite like for like, and on the safe side: measured on real answers
   * (Nov 2026), Mapbox's time for a path asked through via points ran 3 to
   * 13% BELOW its time for the same path as an ordinary route. So the
   * current route looks a little better than it is, and a switch measured
   * against this baseline saves at least what is said.
   */
  readonly baseline?: readonly RouteCandidate[] | null
  /**
   * How far the driver has gone along the current route since the query was
   * sent, in meters, when the caller measures it (GPS): the answer is judged
   * where the driver is when it is used, not where it was asked from. Every
   * turn-off is that much nearer, for the too-late rule and for what is said.
   * Left out, or not a positive number: 0 (the simulated drive, whose clock
   * stands still while a query is out).
   */
  readonly drivenSinceM?: number
}

/** Why a decision came out as it did, for logs and tests. The `reason` text says the same in words. */
export type RerouteCode =
  | 'poll-failed'
  | 'no-routes'
  | 'off-route'
  | 'route-unconfirmed'
  | 'route-lost'
  | 'no-eta'
  | 'no-traffic-data'
  | 'no-alternative'
  | 'current-best'
  | 'saving-too-small'
  | 'saving-share-too-small'
  | 'probe-unconfirmed'
  | 'recently-abandoned'
  | 'driver-declined'
  | 'too-late'
  | 'confirming'
  | 'cooldown'
  | 'faster-route'

/** The alternative a decision was about: the one switched to, or the one that came closest. */
export interface RerouteAlternative {
  /** Its id among this poll's candidates. Ids are only good within one poll. */
  readonly routeId: string
  /** Seconds it saves against the current route's fresh ETA. Null when the current route's ETA is unknown. */
  readonly savingSec: number | null
  /** Meters from the driver to where it leaves the current route (or to its own first maneuver, if that is sooner). */
  readonly turnInM: number
  /** That point on the map. */
  readonly turnAt: LngLat
  /** The lead distance the rules ask for here, in meters. */
  readonly requiredLeadM: number
  /** True when the turn-off is on controlled-access road, where the longer lead applies. */
  readonly onFreeway: boolean
}

export interface RerouteDecision {
  readonly action: 'stay' | 'switch'
  /** With 'switch': the id of the candidate (of this poll) to drive from now on. */
  readonly toRouteId?: string
  /** One short plain-English sentence, fit to be spoken aloud. */
  readonly reason: string
  readonly code: RerouteCode
  /** Null when the decision was not about one particular alternative. */
  readonly considered: RerouteAlternative | null
  /**
   * The fresh travel time of the route being driven, from the driver to the
   * destination, when this poll gave one: the like-for-like baseline. `asked`
   * is true when it came from the request for the current path itself
   * (RerouteObservation.baseline) and not from the fresh routes. Null when
   * it is unknown, and on a switch (the route is another one from now on).
   */
  readonly current: { readonly durationSec: number; readonly distanceM: number; readonly asked: boolean } | null
  /** Pass this back with the next observation. */
  readonly nextState: RerouteState
}

function numberOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Fills in defaults. A threshold that is negative or not a number falls back to its default. */
function resolveOptions(options: Partial<RerouteOptions>): RerouteOptions {
  const d = DEFAULT_REROUTE_OPTIONS
  return {
    minSavingSec: numberOr(options.minSavingSec, d.minSavingSec),
    minSavingFraction: numberOr(options.minSavingFraction, d.minSavingFraction),
    confirmPolls: Math.max(1, Math.round(numberOr(options.confirmPolls, d.confirmPolls))),
    cooldownSec: numberOr(options.cooldownSec, d.cooldownSec),
    noReturnSec: numberOr(options.noReturnSec, d.noReturnSec),
    returnSavingFactor: Math.max(1, numberOr(options.returnSavingFactor, d.returnSavingFactor)),
    minLeadDistanceM: numberOr(options.minLeadDistanceM, d.minLeadDistanceM),
    minLeadTimeSec: numberOr(options.minLeadTimeSec, d.minLeadTimeSec),
    freewayLeadDistanceM: numberOr(options.freewayLeadDistanceM, d.freewayLeadDistanceM),
    routeLostPolls: Math.max(1, Math.round(numberOr(options.routeLostPolls, d.routeLostPolls))),
    routeLostWindowSec: numberOr(options.routeLostWindowSec, d.routeLostWindowSec),
    offRouteM: numberOr(options.offRouteM, d.offRouteM),
    sameRouteToleranceM: numberOr(options.sameRouteToleranceM, d.sameRouteToleranceM),
    matchToleranceM: numberOr(options.matchToleranceM, d.matchToleranceM),
    matchMinOverlap: Math.min(1, numberOr(options.matchMinOverlap, d.matchMinOverlap)),
    matchMaxGapM: numberOr(options.matchMaxGapM, d.matchMaxGapM),
    matchMaxDivergenceM: numberOr(options.matchMaxDivergenceM, d.matchMaxDivergenceM),
    matchIgnoreStartM: numberOr(options.matchIgnoreStartM, d.matchIgnoreStartM),
    matchStartSearchM: numberOr(options.matchStartSearchM, d.matchStartSearchM),
    baselineViaSpacingM: Math.max(1, numberOr(options.baselineViaSpacingM, d.baselineViaSpacingM)),
    baselineMaxViaPoints: Math.max(1, Math.round(numberOr(options.baselineMaxViaPoints, d.baselineMaxViaPoints))),
    returnOverlapFraction: numberOr(options.returnOverlapFraction, d.returnOverlapFraction),
    requireTypicalDuration: options.requireTypicalDuration ?? d.requireTypicalDuration,
    etaTieWindowSec: numberOr(options.etaTieWindowSec, d.etaTieWindowSec),
  }
}

/** "40 seconds", "1.9 minutes", "3 minutes". Rounded down, so a saving is never overstated. */
export function spokenDuration(sec: number): string {
  const s = Number.isFinite(sec) ? Math.max(0, sec) : 0
  if (s < 90) {
    const whole = Math.floor(s)
    return whole === 1 ? '1 second' : `${whole} seconds`
  }
  const tenths = Math.floor(s / 6) / 10
  const minutes = tenths < 10 ? tenths : Math.floor(tenths)
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

const M_PER_MILE = 1609.344
const FT_PER_M = 3.28084

/** "300 feet", "0.8 miles", "1 mile". Rounded down, so a turn is never said to be farther than it is. */
export function spokenDistance(meters: number): string {
  const m = Number.isFinite(meters) ? Math.max(0, meters) : 0
  const tenths = Math.floor((m / M_PER_MILE) * 10) / 10
  if (tenths < 0.1) return `${Math.floor((m * FT_PER_M) / 50) * 50} feet`
  return tenths === 1 ? '1 mile' : `${tenths} miles`
}

/**
 * The closest point of a line to P: how far it is, and where along the line
 * (as segment index and share of it). With `firstM`, only the segments that
 * begin within the first `firstM` meters of the line are looked at.
 */
function nearestOnLine(
  p: XY,
  line: readonly XY[],
  meter?: MatchMeter,
  firstM = Infinity,
): { distanceM: number; index: number; t: number } {
  let best = { distanceM: Infinity, index: 0, t: 0 }
  const only = line[0]
  if (line.length === 1 && only !== undefined) {
    return { distanceM: Math.hypot(p[0] - only[0], p[1] - only[1]), index: 0, t: 0 }
  }
  let beginsAtM = 0
  for (let i = 1; i < line.length && beginsAtM <= firstM; i++) {
    if (meter !== undefined) meter.segmentChecks++
    const hit = pointToSegment(p, line[i - 1]!, line[i]!)
    if (hit.distanceM < best.distanceM) best = { distanceM: hit.distanceM, index: i - 1, t: hit.t }
    beginsAtM += apart(line[i - 1]!, line[i]!)
  }
  return best
}

function isNear(p: XY, line: readonly XY[], toleranceM: number): boolean {
  for (let i = 1; i < line.length; i++) {
    if (pointToSegment(p, line[i - 1]!, line[i]!).distanceM <= toleranceM) return true
  }
  return false
}

const apart = (p: XY, q: XY) => Math.hypot(p[0] - q[0], p[1] - q[1])

export type { MatchMeter } from './geo.ts'

function lengthOf(line: readonly XY[]): number {
  let total = 0
  for (let i = 1; i < line.length; i++) total += apart(line[i - 1]!, line[i]!)
  return total
}

/** A stretch of a line, in meters from its start. */
type Stretch = readonly [fromM: number, toM: number]

/** What stretchesApart found: the stretches apart, their total and longest, and how far the farthest point of them is (Infinity: beyond the grid's reach). */
interface Apart {
  readonly stretches: readonly Stretch[]
  readonly totalM: number
  readonly longestM: number
  readonly farthestM: number
}

/** The limits under which a comparison can still be "the same route": past any of them, stretchesApart may stop. */
interface ApartLimits {
  readonly totalM: number
  readonly longestM: number
  readonly farthestM: number
}

/**
 * Walks `line` from `fromM` meters after its start to its end in steps of
 * half the tolerance, and reports the stretches that are farther than the
 * tolerance from `other`. Works on length, not on vertices, so two drawings
 * of one road with different numbers of points measure the same.
 *
 * With `limits`, it gives up (null) as soon as the stretches apart break one
 * of them: the answer is "not the same route" then, whatever comes after.
 */
function stretchesApart(
  line: readonly XY[],
  other: SegmentGrid,
  fromM: number,
  toleranceM: number,
  limits: ApartLimits | null = null,
): Apart | null {
  const stepM = Math.max(1, toleranceM / 2)
  const stretches: Stretch[] = []
  let open: [number, number] | null = null
  let closedM = 0
  let longestM = 0
  let farthestM = 0
  /** False when a limit is broken. */
  const visit = (p: XY, atM: number, weighsM: number): boolean => {
    const distanceM = other.distanceWithin(p, toleranceM)
    if (distanceM <= toleranceM) {
      if (open !== null) {
        stretches.push(open)
        closedM += open[1] - open[0]
      }
      open = null
      return true
    }
    if (open === null) open = [atM, atM + weighsM]
    else open[1] = atM + weighsM
    const openM = open[1] - open[0]
    longestM = Math.max(longestM, openM)
    farthestM = Math.max(farthestM, distanceM)
    return limits === null || (closedM + openM <= limits.totalM && openM <= limits.longestM && farthestM <= limits.farthestM)
  }
  let doneM = 0
  let nextM = fromM
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!
    const b = line[i]!
    const lengthM = apart(a, b)
    while (lengthM > 0 && doneM + lengthM >= nextM) {
      const t = (nextM - doneM) / lengthM
      if (!visit([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], nextM, stepM)) return null
      nextM += stepM
    }
    doneM += lengthM
  }
  // TypeScript cannot see the assignments made inside the closure.
  const last = open as [number, number] | null
  if (last !== null) {
    stretches.push(last)
    closedM += last[1] - last[0]
  }
  return { stretches, totalM: closedM, longestM, farthestM }
}

/** The thresholds of compareRest: the match* part of RerouteOptions. */
type MatchOptions = Pick<
  RerouteOptions,
  'matchToleranceM' | 'matchMinOverlap' | 'matchMaxGapM' | 'matchMaxDivergenceM' | 'matchIgnoreStartM' | 'matchStartSearchM'
>

/** How a fresh route compares with the rest of a path. */
interface RestComparison {
  /** True when the fresh route IS the rest of the path (see compareRest). */
  readonly same: boolean
  /** Meters of either line that run apart from the other, plus the difference of their lengths: the smaller, the closer. */
  readonly differenceM: number
  /** The stretches of `rest` that the fresh route does not run along, in meters from the start of `rest`. */
  readonly restApart: readonly Stretch[]
  /** The rest of the path, from the point of it nearest to where the fresh route starts. */
  readonly rest: readonly XY[]
}

/** `line` from the point `at` (of nearestOnLine) on. */
function fromNearest(line: readonly XY[], at: { index: number; t: number }): XY[] {
  const a = line[at.index]!
  const b = line[at.index + 1]!
  return [[a[0] + (b[0] - a[0]) * at.t, a[1] + (b[1] - a[1]) * at.t], ...line.slice(at.index + 1)]
}

/** What both ways of comparing (compareRest, matchRest) measure first. Null when either line cannot be driven. */
function setUp(path: readonly XY[], given: readonly XY[], options: MatchOptions, meter: MatchMeter | undefined) {
  const start = given[0]
  if (start === undefined || given.length < 2 || path.length < 2) return null
  // The start is near the beginning of the path, which is where the driver is (#74): the
  // whole path is searched only when it is not, so that a later pass of the same spot
  // (a cloverleaf) is never taken for where the driver is.
  const near = nearestOnLine(start, path, meter, options.matchStartSearchM)
  const at = near.distanceM <= options.matchToleranceM ? near : nearestOnLine(start, path, meter)
  const rest = fromNearest(path, at)
  // A fresh route that starts behind the path (fetched a moment before the position was
  // taken: see RerouteObservation.positionAlongM) is compared from where it reaches the
  // path's start, when it does: the part behind runs along the road already driven, which
  // is not a way apart, however far behind it begins. Only a straight approach is cut (no
  // longer than the way from its start to the path's, give or take the tolerance): a route
  // that first drives off the other way and turns back is not shortened into a match.
  let fresh = given
  if (at.index === 0 && at.t === 0) {
    const back = nearestOnLine(path[0]!, given, meter)
    const cutM = lengthOf(given.slice(0, back.index + 1)) + back.t * apart(given[back.index]!, given[back.index + 1]!)
    if (back.distanceM <= options.matchToleranceM && cutM <= apart(start, path[0]!) + options.matchToleranceM) {
      fresh = fromNearest(given, back)
    }
  }
  const freshM = lengthOf(fresh)
  const restM = lengthOf(rest)
  const shorterM = Math.min(freshM, restM)
  if (!(shorterM > 0)) return null
  // A line shorter than twice the ignored start is still compared over its second half.
  const ignoreM = Math.min(options.matchIgnoreStartM, shorterM / 2)
  const limits: ApartLimits = {
    totalM: (1 - options.matchMinOverlap) * (shorterM - ignoreM),
    longestM: options.matchMaxGapM,
    farthestM: options.matchMaxDivergenceM,
  }
  const reachM = Math.max(options.matchToleranceM, options.matchMaxDivergenceM)
  return {
    fresh,
    rest,
    ignoreM,
    limits,
    lengthsApartM: Math.abs(freshM - restM),
    endsTogether: apart(fresh.at(-1)!, rest.at(-1)!) <= options.matchToleranceM,
    grids: () => ({ ofRest: segmentGrid(rest, reachM, meter), ofFresh: segmentGrid(fresh, reachM, meter) }),
  }
}

/**
 * Compares `fresh` (a route from the driver's position to the destination)
 * with the rest of `path` (the route being driven, from about where the
 * driver is). `fresh` IS the rest of `path` when, from where it starts:
 *
 * - both lines end at the same place (within `matchToleranceM`);
 * - leaving out the first `matchIgnoreStartM` meters, at least
 *   `matchMinOverlap` of each line's length runs within `matchToleranceM` of
 *   the other line (the allowance is that share of the SHORTER line);
 * - no single stretch apart is longer than `matchMaxGapM`, and the two
 *   lengths differ by no more than that (a route that overshoots and comes
 *   back along the same road is longer, though never apart);
 * - no point of a stretch apart is farther than `matchMaxDivergenceM` from
 *   the other line (a block around is another road, however short).
 *
 * Measured by length along the lines, not vertex by vertex: the same road
 * drawn with more or fewer points is the same road. Null when either line
 * cannot be driven (fewer than two points, no length). This one measures
 * everything (baselineProbe needs every stretch apart); matchRest decides
 * `same` the same way and stops as soon as it is decided.
 */
function compareRest(path: readonly XY[], fresh: readonly XY[], options: MatchOptions, meter?: MatchMeter): RestComparison | null {
  const s = setUp(path, fresh, options, meter)
  if (s === null) return null
  const { ofRest, ofFresh } = s.grids()
  const freshApart = stretchesApart(s.fresh, ofRest, s.ignoreM, options.matchToleranceM)!
  const restApart = stretchesApart(s.rest, ofFresh, s.ignoreM, options.matchToleranceM)!
  const within = (found: Apart) =>
    found.totalM <= s.limits.totalM && found.longestM <= s.limits.longestM && found.farthestM <= s.limits.farthestM
  const same = s.endsTogether && s.lengthsApartM <= options.matchMaxGapM && within(freshApart) && within(restApart)
  return { same, differenceM: freshApart.totalM + restApart.totalM + s.lengthsApartM, restApart: restApart.stretches, rest: s.rest }
}

/**
 * compareRest's `differenceM` when `fresh` is the rest of `path`, null when
 * it is not. The cheap way (#51): the ends and the lengths are checked before
 * any walking, and each walk stops at the first stretch that rules the match
 * out, so a route that parts from the path costs about as much as the shared
 * part up to where it leaves.
 */
function matchRest(path: readonly XY[], fresh: readonly XY[], options: MatchOptions, meter?: MatchMeter): number | null {
  const s = setUp(path, fresh, options, meter)
  if (s === null || !s.endsTogether || s.lengthsApartM > options.matchMaxGapM) return null
  const { ofRest, ofFresh } = s.grids()
  const freshApart = stretchesApart(s.fresh, ofRest, s.ignoreM, options.matchToleranceM, s.limits)
  if (freshApart === null) return null
  const restApart = stretchesApart(s.rest, ofFresh, s.ignoreM, options.matchToleranceM, s.limits)
  if (restApart === null) return null
  return freshApart.totalM + restApart.totalM + s.lengthsApartM
}

/** True when `fresh` is the rest of `path` (see compareRest). */
function continuesPath(path: readonly XY[], fresh: readonly XY[], options: MatchOptions): boolean {
  return matchRest(path, fresh, options) !== null
}

/**
 * Of `routes`, the one that is the rest of `path`: when more than one is
 * (the same road twice, with a small variation), the closest; of equals, the
 * first in the given order. Null when none is.
 */
function closestToPath(
  path: readonly XY[],
  routes: readonly RouteCandidate[],
  project: (p: LngLat) => XY,
  options: MatchOptions,
  meter?: MatchMeter,
): RouteCandidate | null {
  let best: { route: RouteCandidate; differenceM: number } | null = null
  for (const route of routes) {
    const differenceM = matchRest(path, route.geometry.filter(isValidLngLat).map(project), options, meter)
    if (differenceM === null) continue
    if (best === null || differenceM < best.differenceM) best = { route, differenceM }
  }
  return best?.route ?? null
}

/** Everything the rules need to know about the lines of one poll, on one flat plane. */
interface Plane {
  readonly project: (p: LngLat) => XY
  /** The current route from the driver's position (less a little slack, see aheadOf) on. */
  readonly ahead: readonly XY[]
  readonly toleranceM: number
}

/**
 * The current route from a little behind the reported position on
 * (`slackM`), so that fresh routes fetched a moment before the position was
 * taken, which start slightly behind the driver, still start on the line.
 */
function aheadOf(geometry: readonly LngLat[], positionAlongM: number, slackM: number): LngLat[] {
  return lineFrom(geometry.filter(isValidLngLat), Math.max(0, positionAlongM - slackM))
}

function planeOf(observation: RerouteObservation, toleranceM: number, slackM: number): Plane | null {
  const ahead = aheadOf(observation.route.geometry, observation.positionAlongM, slackM)
  const origin = ahead[0]
  if (origin === undefined) return null
  const project = localProjector(origin)
  return { project, ahead: ahead.map(project), toleranceM }
}

/**
 * Which fresh candidate IS the rest of the route being driven: the like-for-
 * like baseline. Matched by path only (ids differ between polls and are never
 * compared), by the rule of compareRest: the same roads to the same place,
 * give or take how the line is drawn, where it starts, and a variation too
 * small to be another route. When more than one matches, the closest. Null
 * when none does: the current route is not among the fresh routes (which
 * does not make it a bad route: see decideReroute, rule 5).
 *
 * `meter`, when given, is counted up with the work done (see MatchMeter); the
 * answer is the same with or without it.
 */
export function findCurrentRoute(
  route: Pick<RouteCandidate, 'geometry'>,
  positionAlongM: number,
  candidates: readonly RouteCandidate[],
  options: Partial<RerouteOptions> = {},
  meter?: MatchMeter,
): RouteCandidate | null {
  const opts = resolveOptions(options)
  const ahead = aheadOf(route.geometry, positionAlongM, opts.offRouteM)
  const origin = ahead[0]
  if (origin === undefined) return null
  const project = localProjector(origin)
  return closestToPath(ahead.map(project), candidates, project, opts, meter)
}

/** A point for the provider to route through, with the direction of travel there. */
export interface BaselineViaPoint {
  readonly point: LngLat
  /** Degrees clockwise from true north. */
  readonly bearingDeg: number
}

/**
 * When a poll's fresh routes do not include the rest of the route being
 * driven, the current route has no fresh travel time, and nothing can be
 * compared like for like. This answers how to ask for one: the points along
 * the current path to send as via points of one more directions request,
 * whose answer goes into RerouteObservation.baseline.
 *
 * The points are put where they are needed: on the stretches of the current
 * path that a fresh route does not run along (where it does, the provider is
 * on this path already), one in the middle of a short stretch and one every
 * `baselineViaSpacingM` of a long one. A stretch that two fresh routes both
 * leave is pinned once. At most `baselineMaxViaPoints` in all, thinned evenly
 * when there are more.
 *
 * Null when no request is needed or none can be made: no usable fresh route,
 * one of them already is the current route, or there is no stretch to pin.
 * Pure: it only says what to ask; the caller sends the request.
 */
export function baselineProbe(
  route: Pick<RouteCandidate, 'geometry'>,
  positionAlongM: number,
  candidates: readonly RouteCandidate[],
  options: Partial<RerouteOptions> = {},
): { readonly via: readonly BaselineViaPoint[] } | null {
  const opts = resolveOptions(options)
  const usable = candidates.filter((c) => c.geometry.filter(isValidLngLat).length >= 2)
  if (usable.length === 0) return null
  const aheadLine = aheadOf(route.geometry, positionAlongM, opts.offRouteM)
  const origin = aheadLine[0]
  if (origin === undefined) return null
  const project = localProjector(origin)
  const ahead = aheadLine.map(project)
  if (closestToPath(ahead, usable, project, opts) !== null) return null

  // Where along the current path (in meters before its end) a via point is wanted.
  const wanted: number[] = []
  for (const { route: fresh } of rankRoutes(usable, { etaTieWindowSec: opts.etaTieWindowSec })) {
    const compared = compareRest(ahead, fresh.geometry.filter(isValidLngLat).map(project), opts)
    if (compared === null) continue
    const restM = lengthOf(compared.rest)
    for (const [fromM, toM] of compared.restApart) {
      const count = Math.max(1, Math.ceil((toM - fromM) / opts.baselineViaSpacingM))
      for (let k = 0; k < count; k++) {
        const beforeEndM = restM - (fromM + ((toM - fromM) * (k + 0.5)) / count)
        // One point pins a place, however many fresh routes leave the path there.
        if (!wanted.some((w) => Math.abs(w - beforeEndM) < opts.baselineViaSpacingM / 2)) wanted.push(beforeEndM)
      }
    }
  }
  if (wanted.length === 0) return null
  // In driving order; too many: every n-th, so that they stay spread over the whole way.
  wanted.sort((x, y) => y - x)
  const keep = Math.min(wanted.length, opts.baselineMaxViaPoints)
  const aheadM = alongRouteM(aheadLine).at(-1) ?? 0
  const via: BaselineViaPoint[] = []
  for (let k = 0; k < keep; k++) {
    const on = pointAtDistance(aheadLine, aheadM - wanted[Math.floor(((k + 0.5) * wanted.length) / keep)]!)
    if (on !== null) via.push({ point: on.point, bearingDeg: on.bearingDeg })
  }
  return via.length === 0 ? null : { via }
}

/**
 * Where a candidate leaves the current route ahead of the driver: the last
 * vertex of the candidate that is still on the current route before the
 * first one that is not, as meters along the candidate (which starts at the
 * driver, so this is the distance to the turn-off). Null when it never
 * leaves, or has no usable line.
 */
function divergence(
  line: readonly LngLat[],
  xy: readonly XY[],
  plane: Plane,
): { atM: number; at: LngLat; index: number } | null {
  const firstOff = xy.findIndex((p) => !isNear(p, plane.ahead, plane.toleranceM))
  if (firstOff < 0) return null
  const index = Math.max(0, firstOff - 1)
  return { atM: alongRouteM(line.slice(0, index + 1)).at(-1) ?? 0, at: line[index]!, index }
}

const isEndpointManeuver = (m: Maneuver) => m.kind.startsWith('depart') || m.kind.startsWith('arrive')

/**
 * The candidate's first maneuver that the current route does not also make:
 * no maneuver of the same kind at the same place (within the tolerance) on
 * the current route. Departing and arriving are not maneuvers to plan for.
 */
function firstOwnManeuver(
  candidate: RouteCandidate,
  current: readonly Maneuver[],
  plane: Plane,
): Maneuver | null {
  const shared = current.filter((m) => !isEndpointManeuver(m)).map((m) => ({ kind: m.kind, at: plane.project(m.location) }))
  for (const m of candidate.maneuvers) {
    if (isEndpointManeuver(m) || !Number.isFinite(m.atDistanceM) || !isValidLngLat(m.location)) continue
    const at = plane.project(m.location)
    if (!shared.some((s) => s.kind === m.kind && apart(s.at, at) <= plane.toleranceM)) return m
  }
  return null
}

function insideSpan(spans: readonly DistanceSpanM[] | null, atM: number): boolean {
  return spans !== null && spans.some(([startM, endM]) => atM >= startM - 1 && atM <= endM + 1)
}

/**
 * The share of a candidate's own part (from where it leaves the current
 * route on, the stretches not on the current route) that runs along `other`.
 */
function shareAlong(xy: readonly XY[], fromIndex: number, plane: Plane, other: readonly XY[]): number {
  let ownM = 0
  let alongOtherM = 0
  let previousOwn = false
  for (let i = fromIndex + 1; i < xy.length; i++) {
    const own = !isNear(xy[i]!, plane.ahead, plane.toleranceM)
    if (own || previousOwn) {
      const lengthM = apart(xy[i - 1]!, xy[i]!)
      ownM += lengthM
      if (isNear(xy[i - 1]!, other, plane.toleranceM) && isNear(xy[i]!, other, plane.toleranceM)) alongOtherM += lengthM
    }
    previousOwn = own
  }
  return ownM > 0 ? alongOtherM / ownM : 0
}

/** One alternative, measured against the current route. */
interface Measured {
  readonly candidate: RouteCandidate
  readonly xy: readonly XY[]
  readonly alternative: RerouteAlternative
  readonly divergedAtIndex: number
}

/**
 * Where and how soon the driver would have to act to take `candidate`, and
 * the lead the rules ask for there. Null when the candidate never leaves the
 * current route (it is the current route, or part of it).
 */
function measure(
  candidate: RouteCandidate,
  savingSec: number | null,
  currentManeuvers: readonly Maneuver[],
  currentSpans: readonly DistanceSpanM[] | null,
  speedMps: number,
  plane: Plane,
  options: RerouteOptions,
  drivenM: number,
): Measured | null {
  const line = candidate.geometry.filter(isValidLngLat)
  const xy = line.map(plane.project)
  const split = divergence(line, xy, plane)
  if (split === null) return null
  // Geometry alone can see the split late: an exit ramp runs within a few
  // meters of the freeway for its first stretch. The maneuver says where the
  // driver really has to act, so the sooner of the two is used.
  const own = firstOwnManeuver(candidate, currentManeuvers, plane)
  const byManeuver = own !== null && own.atDistanceM < split.atM
  const askedTurnInM = byManeuver ? Math.max(0, own.atDistanceM) : split.atM
  // From where the driver is now: the turn-off came nearer while the answer was out.
  const turnInM = Math.max(0, askedTurnInM - drivenM)
  const turnAt = byManeuver ? own.location : split.at
  // Freeway when the road at the turn-off is controlled-access on the candidate's
  // own record, or else on the current route's. Unknown road class is not freeway:
  // the speed rule (minLeadTimeSec) still stretches the lead at freeway speeds.
  const onFreeway = insideSpan(candidate.limitedAccessSpansM ?? currentSpans, askedTurnInM)
  const speed = Number.isFinite(speedMps) && speedMps > 0 ? speedMps : 0
  const requiredLeadM = Math.max(
    options.minLeadDistanceM,
    speed * options.minLeadTimeSec,
    onFreeway ? options.freewayLeadDistanceM : 0,
  )
  return {
    candidate,
    xy,
    alternative: { routeId: candidate.id, savingSec, turnInM, turnAt, requiredLeadM, onFreeway },
    divergedAtIndex: split.index,
  }
}

/** The limited-access spans of the route being driven, re-measured from the driver's position. */
function spansAhead(spans: readonly DistanceSpanM[] | null, positionAlongM: number): DistanceSpanM[] | null {
  if (spans === null) return null
  return spans
    .filter(([, endM]) => endM > positionAlongM)
    .map(([startM, endM]): DistanceSpanM => [Math.max(0, startM - positionAlongM), endM - positionAlongM])
}

function usableEta(route: RouteCandidate): boolean {
  return Number.isFinite(route.durationSec) && route.durationSec >= 0
}

/**
 * Decides, after one poll, whether to stay on the route being driven or to
 * switch to another one. Call it once per poll with the state the last call
 * returned (INITIAL_REROUTE_STATE at the start of a drive). On 'switch' the
 * caller starts driving the candidate `toRouteId` and from then on reports
 * positions along that route.
 *
 * The rules, in the order they are applied:
 *
 * 1. **Failed poll** (candidates null): stay. Only the failedPolls counter
 *    changes, however many polls fail in a row; a confirmation in progress
 *    is neither advanced nor lost.
 * 2. **No usable routes** (empty list, or no route with a line to drive): stay.
 * 3. **Off route**: the fresh routes start more than `offRouteM` from the
 *    current route's line, anywhere along it (or the caller says so with
 *    observation.offRouteM).
 *    The current route is not being driven any more, so the top-ranked fresh
 *    route is taken at once: no saving, confirmation, cooldown or lead test.
 * 4. **Like-for-like baseline.** The fresh candidate that IS the rest of the
 *    current route (findCurrentRoute: the same roads from the driver to the
 *    destination, by overlap: `matchMinOverlap` of the length within
 *    `matchToleranceM`, no stretch apart longer than `matchMaxGapM` or
 *    farther than `matchMaxDivergenceM` from the current line, the
 *    first `matchIgnoreStartM` not compared) gives the current route's fresh
 *    ETA. A fresh route that is the same road with a small variation (the
 *    other lane group at an exit, a corner drawn differently) is the current
 *    route for this purpose, and is never an alternative. Route ids are
 *    never compared across polls.
 * 5. **Current route not among the fresh routes.** That alone says little:
 *    the provider returns three routes at most, and the driver is still on a
 *    perfectly good road. So the current route and its guidance are KEPT,
 *    and its ETA is asked for by other means: the caller requests the current
 *    path itself (baselineProbe) and passes the answer as
 *    `observation.baseline`.
 *    - The answer is the current path: that is the baseline, and rules 6 to
 *      12 apply as always. A switch then is an ordinary 'faster-route' one,
 *      with a real saving of at least the minimum.
 *    - No answer (not asked, the request failed, or a via point would not
 *      snap to a road), or the answer is some other path (the via points did
 *      not pin it): nothing is known; stay. The count of the next case is
 *      kept as it is, neither added to nor started over.
 *    - The provider found NO route through the points on the road ahead.
 *      Once that has happened `routeLostPolls` times within the last
 *      `routeLostWindowSec` (older answers no longer count), with no poll
 *      between that found the current route, the road ahead
 *      is taken to be closed, and the best-ranked fresh route that still
 *      passes the too-late guard is taken, once the cooldown is over. Until
 *      then: stay. (The no-return rule cannot be applied here, there being
 *      no saving to double, and is not.) This is the only switch without a
 *      saving besides off route, and it says so.
 * 6. **Missing data.** No travel time on the current route, or (with
 *    `requireTypicalDuration`) no typical duration on it, so its ETA is not
 *    known to include traffic: stay. An alternative lacking either is passed
 *    over. No alternative at all: stay.
 * 7. **Order of preference** is rankRoutes: best ETA first, signal count only
 *    breaking ETA ties, counts with partial coverage unknown. The
 *    alternatives are tried in that order and the first to pass rules 8 to
 *    10 wins the poll. So signals choose between alternatives the ETA cannot
 *    tell apart, and never justify a switch on their own: fewer signals with
 *    an equal ETA is not worth a change of route in the middle of a drive.
 * 8. **Minimum saving**: baseline ETA minus the alternative's ETA must be at
 *    least `minSavingSec` AND at least `minSavingFraction` of the baseline.
 *    For a side-street probe (source 'probe'), asked through a via point, the
 *    baseline is the current path asked the same way (observation.baseline,
 *    matched to the current path), and never more than its ordinary time:
 *    via-asked times run low (README), and either may read high. Without such a time this poll the probe cannot win or
 *    count towards confirmation ('probe-unconfirmed'). Probes are never the
 *    current route, the off-route pick or the route-lost pick.
 * 9. **No return**: an alternative that goes back to a route left less than
 *    `noReturnSec` ago (see returnOverlapFraction) needs `returnSavingFactor`
 *    times both minimums.
 *    A route the driver turned down (declineRoute) is not offered again
 *    at all until its time is up, whatever it saves.
 * 10. **Too late**: the turn-off is where the alternative's line leaves the
 *    current route's line ahead of the driver, or the alternative's first
 *    maneuver that the current route does not share, whichever is sooner.
 *    It must be at least max(`minLeadDistanceM`, speed x `minLeadTimeSec`)
 *    ahead, and at least `freewayLeadDistanceM` when it is on controlled-
 *    access road (limitedAccessSpansM). Ahead of where the driver is now:
 *    observation.drivenSinceM is taken off first.
 * 11. **Confirmation**: the winner must be the same alternative (same path
 *    ahead) for `confirmPolls` polls in a row. A poll with no winner, or a
 *    different one, starts the count again.
 * 12. **Cooldown**: no switch within `cooldownSec` of the last one. The
 *    confirmation count keeps running meanwhile.
 *
 * Pure: no clock, no randomness, no I/O. Never throws on odd input.
 */
export function decideReroute(
  state: RerouteState,
  observation: RerouteObservation,
  options: Partial<RerouteOptions> = {},
): RerouteDecision {
  const opts = resolveOptions(options)
  const nowSec = observation.nowSec
  const stay = (
    code: RerouteCode,
    reason: string,
    nextState: RerouteState,
    considered: RerouteAlternative | null = null,
    current: RerouteDecision['current'] = null,
  ): RerouteDecision => ({ action: 'stay', reason: `Staying: ${reason}`, code, considered, current, nextState })

  // Rule 1.
  if (observation.candidates === null) {
    const failedPolls = state.failedPolls + 1
    return stay(
      'poll-failed',
      failedPolls === 1 ? 'could not check for faster routes' : `could not check for faster routes, ${failedPolls} tries in a row`,
      { ...state, failedPolls },
    )
  }

  // What every answered poll does to the state, whatever is decided.
  const base: RerouteState = {
    ...state,
    failedPolls: 0,
    abandoned: state.abandoned.filter((a) => nowSec - a.atSec < opts.noReturnSec),
    declined: (state.declined ?? []).filter((d) => d.untilSec > nowSec),
  }
  const noWinner: RerouteState = { ...base, pending: null }

  // Rule 2.
  const candidates = observation.candidates.filter((c) => c.geometry.filter(isValidLngLat).length >= 2)
  const plane = planeOf(observation, opts.sameRouteToleranceM, opts.offRouteM)
  if (candidates.length === 0 || plane === null) return stay('no-routes', 'no routes available right now', noWinner)
  // A route without a travel time ranks last (see rankRoutes) and is never switched to.
  const ranked = rankRoutes(candidates, { etaTieWindowSec: opts.etaTieWindowSec }).map((r) => r.route)
  // Side-street probes (source 'probe') are asked through a via point: their times are compared
  // only with a time for the current path asked the same way (rule 8), and they are never the
  // current route, the off-route pick or the route-lost pick.
  const isProbe = (c: RouteCandidate) => c.source === 'probe'
  const provided = ranked.filter((c) => !isProbe(c))
  const drivenM =
    observation.drivenSinceM !== undefined && Number.isFinite(observation.drivenSinceM) && observation.drivenSinceM > 0
      ? observation.drivenSinceM
      : 0

  const switchTo = (
    code: RerouteCode,
    reason: string,
    to: RouteCandidate,
    considered: RerouteAlternative | null,
  ): RerouteDecision => ({
    action: 'switch',
    toRouteId: to.id,
    reason: `Switching: ${reason}`,
    code,
    considered,
    current: null,
    nextState: {
      pending: null,
      lastSwitchAtSec: nowSec,
      abandoned: [...base.abandoned, { geometry: lineFrom(observation.route.geometry, observation.positionAlongM), atSec: nowSec }],
      failedPolls: 0,
      lostPolls: 0,
      lostAtSec: [],
      declined: base.declined,
    },
  })

  // Rule 3. Measured against the whole route, the part already driven included:
  // fresh routes that start on the route but behind the driver are a stale
  // answer (see RerouteObservation.positionAlongM), not a driver who left the route.
  const startsAt = plane.project(candidates[0]!.geometry.filter(isValidLngLat)[0]!)
  const offBy =
    observation.offRouteM !== undefined && Number.isFinite(observation.offRouteM)
      ? observation.offRouteM
      : nearestOnLine(startsAt, observation.route.geometry.filter(isValidLngLat).map(plane.project)).distanceM
  if (offBy > opts.offRouteM) {
    return switchTo('off-route', 'off the planned route, taking the fastest route from here', provided[0] ?? ranked[0]!, null)
  }

  const sinceSwitchSec = base.lastSwitchAtSec === null ? Infinity : nowSec - base.lastSwitchAtSec
  const coolingDown = sinceSwitchSec < opts.cooldownSec
  const abandonedLines = base.abandoned.map((a) => ({
    atSec: a.atSec,
    xy: a.geometry.filter(isValidLngLat).map(plane.project),
  }))
  /** The route left most recently that this alternative goes back to, if any. */
  const returnsTo = (m: Measured) =>
    abandonedLines
      .filter((a) => shareAlong(m.xy, m.divergedAtIndex, plane, a.xy) >= opts.returnOverlapFraction)
      .sort((a, b) => b.atSec - a.atSec)[0] ?? null
  const declinedLines = (base.declined ?? []).map((d) => d.geometry.filter(isValidLngLat).map(plane.project))
  /** True when this alternative is a route the driver turned down a moment ago (see declineRoute). */
  const wasDeclined = (m: Measured) =>
    declinedLines.some((xy) => shareAlong(m.xy, m.divergedAtIndex, plane, xy) >= opts.returnOverlapFraction)
  const tooLate = (a: RerouteAlternative) => a.turnInM < a.requiredLeadM
  const tooLateReason = (a: RerouteAlternative, what: string) =>
    `${what} turns off in ${spokenDistance(a.turnInM)}, too late to take safely`
  const turnPhrase = (a: RerouteAlternative) => `turn in ${spokenDistance(a.turnInM)}`

  // Rule 4.
  const isCurrent = (c: RouteCandidate) => continuesPath(plane.ahead, c.geometry.filter(isValidLngLat).map(plane.project), opts)
  const offered = closestToPath(plane.ahead, provided, plane.project, opts)
  // Rule 5: not offered, so the answer to the request for the current path itself, if there is one.
  const baseline = Array.isArray(observation.baseline)
    ? (observation.baseline as readonly RouteCandidate[]).filter((c) => c.geometry.filter(isValidLngLat).length >= 2)
    : null
  const current = offered ?? (baseline === null ? null : closestToPath(plane.ahead, baseline, plane.project, opts))

  if (current === null) {
    // Only "no route that way" is evidence against the road ahead, and adds to the count.
    // Not asked, or answered with another path (the via points did not pin it, which says
    // nothing about the road between them, #41): no evidence either way, and the count is
    // kept. Only a poll that finds the current route again starts it over.
    // Answers from longer ago than the window are about a road that may be well behind (#68).
    const recent = (base.lostAtSec ?? []).filter((atSec) => nowSec - atSec <= opts.routeLostWindowSec)
    const lostAtSec = baseline !== null && baseline.length === 0 ? [...recent, nowSec] : recent
    const lostPolls = lostAtSec.length
    const lost: RerouteState = { ...noWinner, lostPolls, lostAtSec }
    if (baseline === null || baseline.length > 0) {
      return stay(
        'route-unconfirmed',
        baseline === null
          ? 'current route is not among the fresh routes, and its travel time could not be checked'
          : 'current route is not among the fresh routes, and asking for it brought back another road',
        lost,
      )
    }
    if (lostPolls < opts.routeLostPolls) {
      return stay(
        'route-unconfirmed',
        `the road ahead could not be routed, check ${lostPolls} of ${opts.routeLostPolls}`,
        lost,
      )
    }
    if (coolingDown) {
      return stay('cooldown', `switched routes ${spokenDuration(sinceSwitchSec)} ago, and the road ahead can no longer be routed`, lost)
    }
    const spans = spansAhead(observation.route.limitedAccessSpansM, observation.positionAlongM)
    let closest: RerouteAlternative | null = null
    for (const candidate of provided.filter(usableEta)) {
      const m = measure(candidate, null, observation.route.maneuvers, spans, observation.speedMps, plane, opts, drivenM)
      if (m === null || wasDeclined(m)) continue
      closest ??= m.alternative
      if (tooLate(m.alternative)) continue
      return switchTo(
        'route-lost',
        `the road ahead can no longer be routed, ${turnPhrase(m.alternative)}`,
        candidate,
        m.alternative,
      )
    }
    return closest === null
      ? stay('route-lost', 'the road ahead can no longer be routed, and there is no other route to take', lost)
      : stay('too-late', tooLateReason(closest, 'the road ahead can no longer be routed, but the other route'), lost, closest)
  }
  const found: RerouteState = { ...base, lostPolls: 0, lostAtSec: [] }
  const foundNoWinner: RerouteState = { ...found, pending: null }
  // Only a time that may be compared (rule 6) is passed on as the current route's ETA.
  const known: RerouteDecision['current'] =
    usableEta(current) && (!opts.requireTypicalDuration || current.typicalDurationSec !== null)
      ? { durationSec: current.durationSec, distanceM: current.distanceM, asked: current !== offered }
      : null

  // The current path's time asked through via points, like a probe's: the answer for the current
  // path itself when it was asked for. Probes are compared with it and nothing else.
  const comparableEta = (c: RouteCandidate) => usableEta(c) && (!opts.requireTypicalDuration || c.typicalDurationSec !== null)
  const asked = current !== offered ? current : baseline === null ? null : closestToPath(plane.ahead, baseline, plane.project, opts)
  const viaCurrent = asked !== null && comparableEta(asked) ? asked : null

  // Rule 6.
  const baselineSec = current.durationSec
  if (!usableEta(current)) return stay('no-eta', 'no travel time for the current route', foundNoWinner, null, known)
  if (opts.requireTypicalDuration && current.typicalDurationSec === null) {
    return stay('no-traffic-data', 'no traffic data for the current route', foundNoWinner, null, known)
  }
  const others = ranked.filter((c) => c !== current && !isCurrent(c))
  if (others.length === 0) return stay('no-alternative', 'no other route available right now', foundNoWinner, null, known)
  const comparable = others.filter(
    (c) => usableEta(c) && (!opts.requireTypicalDuration || c.typicalDurationSec !== null),
  )
  if (comparable.length === 0) return stay('no-traffic-data', 'no comparable travel time for the other routes', foundNoWinner, null, known)

  // Rules 7 to 10: the first alternative, in rank order, that passes them all.
  let winner: Measured | null = null
  let refusal: { code: RerouteCode; reason: string; considered: RerouteAlternative } | null = null
  for (const candidate of comparable) {
    // Like for like: a probed route against the current path asked the same way, through via points.
    const against = isProbe(candidate) ? viaCurrent : current
    if (against === null) {
      // No such time this check: a side street that looks faster cannot count, not even towards confirmation.
      if (candidate.durationSec < baselineSec) {
        const m = measure(candidate, null, current.maneuvers, current.limitedAccessSpansM, observation.speedMps, plane, opts, drivenM)
        if (m !== null) {
          refusal ??= {
            code: 'probe-unconfirmed',
            reason: 'a side street may be faster, but its time could not be compared like for like',
            considered: m.alternative,
          }
        }
      }
      continue
    }
    // Never more than the current route's ordinary time either: a path check can read high too (a
    // later request, a via that snaps onto a slightly longer path), and the lower is the safe one.
    const fromSec = isProbe(candidate) ? Math.min(against.durationSec, baselineSec) : against.durationSec
    const savingSec = fromSec - candidate.durationSec
    if (savingSec <= 0) continue
    const m = measure(candidate, savingSec, current.maneuvers, current.limitedAccessSpansM, observation.speedMps, plane, opts, drivenM)
    if (m === null) continue
    const a = m.alternative
    const refuse = (code: RerouteCode, reason: string) => {
      refusal ??= { code, reason, considered: a }
    }
    if (savingSec < opts.minSavingSec) {
      refuse('saving-too-small', `faster route saves only ${spokenDuration(savingSec)}`)
      continue
    }
    if (savingSec < opts.minSavingFraction * fromSec) {
      refuse(
        'saving-share-too-small',
        `faster route saves only ${spokenDuration(savingSec)} of the remaining ${spokenDuration(fromSec)}`,
      )
      continue
    }
    if (wasDeclined(m)) {
      refuse('driver-declined', `faster route saves ${spokenDuration(savingSec)}, but you chose to keep this route`)
      continue
    }
    const left = returnsTo(m)
    if (
      left !== null &&
      (savingSec < opts.returnSavingFactor * opts.minSavingSec ||
        savingSec < opts.returnSavingFactor * opts.minSavingFraction * fromSec)
    ) {
      refuse(
        'recently-abandoned',
        `faster route is the one we left ${spokenDuration(nowSec - left.atSec)} ago, and it saves only ${spokenDuration(savingSec)}`,
      )
      continue
    }
    if (tooLate(a)) {
      refuse('too-late', tooLateReason(a, 'faster route'))
      continue
    }
    winner = m
    break
  }

  if (winner === null) {
    // TypeScript cannot see the assignments made inside the loop's closure.
    const refused = refusal as { code: RerouteCode; reason: string; considered: RerouteAlternative } | null
    return refused === null
      ? stay('current-best', 'current route is still the fastest', foundNoWinner, null, known)
      : stay(refused.code, refused.reason, foundNoWinner, refused.considered, known)
  }

  // Rule 11.
  const a = winner.alternative
  const saves = `saves ${spokenDuration(a.savingSec ?? 0)}`
  const sameAsPending =
    found.pending !== null &&
    continuesPath(found.pending.geometry.filter(isValidLngLat).map(plane.project), winner.xy, opts)
  const polls = sameAsPending ? found.pending!.polls + 1 : 1
  const confirmed: RerouteState = { ...found, pending: { geometry: winner.candidate.geometry, polls } }
  if (polls < opts.confirmPolls) {
    return stay('confirming', `faster route ${saves}, confirming, check ${polls} of ${opts.confirmPolls}`, confirmed, a, known)
  }
  // Rule 12.
  if (coolingDown) {
    return stay('cooldown', `faster route ${saves}, but we switched routes ${spokenDuration(sinceSwitchSec)} ago`, confirmed, a, known)
  }
  return switchTo('faster-route', `${saves}, ${turnPhrase(a)}`, winner.candidate, a)
}

/**
 * The driver said no to a switch ("Keep previous route"): returns the state
 * to carry on with, in which `geometryAhead` (the turned-down route, from the
 * driver on) is not switched to again before `untilSec`. Pass the state from
 * BEFORE the switch, so the cooldown and the abandoned list are as if the
 * switch had not been made; a confirmation in progress is dropped. Entries
 * whose time is up are removed by the next answered poll.
 */
export function declineRoute(
  state: RerouteState,
  geometryAhead: readonly LngLat[],
  untilSec: number,
): RerouteState {
  return {
    ...state,
    pending: null,
    // Counting lost polls is a confirmation in progress too: start it again.
    lostPolls: 0,
    lostAtSec: [],
    declined: [...(state.declined ?? []), { geometry: geometryAhead, untilSec }],
  }
}
