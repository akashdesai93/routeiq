import {
  alongRouteM,
  decideReroute,
  INITIAL_REROUTE_STATE,
  lineFrom,
  localProjector,
  pointAtDistance,
  pointToSegment,
  type LngLat,
  type Maneuver,
  type RerouteDecision,
  type RerouteOptions,
  type RerouteState,
  type RouteCandidate,
} from '../../src/core/index.ts'

// A made-up road network for scripted drives: a 20 km main road running east
// with a few detours off it. Positions are meters on a flat plane, turned
// into coordinates around a made-up origin. Nothing here is a real place.

const ORIGIN: LngLat = [-81, 35]
const M_PER_DEGREE = 111_195
const M_PER_DEGREE_LNG = M_PER_DEGREE * Math.cos((35 * Math.PI) / 180)

/** The coordinate `xM` meters east and `yM` meters north of the origin. */
export function at(xM: number, yM: number): LngLat {
  return [ORIGIN[0] + xM / M_PER_DEGREE_LNG, ORIGIN[1] + yM / M_PER_DEGREE]
}

type Corner = readonly [xM: number, yM: number]

/** A road through the corners, with a vertex every 250 m the way a real route has them. */
function road(corners: readonly Corner[]): LngLat[] {
  const line: LngLat[] = []
  corners.forEach(([x, y], i) => {
    const previous = corners[i - 1]
    if (previous !== undefined) {
      const length = Math.hypot(x - previous[0], y - previous[1])
      const pieces = Math.max(1, Math.round(length / 250))
      for (let k = 1; k < pieces; k++) {
        line.push(at(previous[0] + ((x - previous[0]) * k) / pieces, previous[1] + ((y - previous[1]) * k) / pieces))
      }
    }
    line.push(at(x, y))
  })
  return line
}

/**
 * The routes of the network, each from the start (0, 0) to the end (20 km, 0):
 * - A: the main road, straight east.
 * - B: leaves A at 5 km, runs 1 km north of it, rejoins at 15 km.
 * - C: leaves A at 8 km, runs 1 km south of it, rejoins at 12 km.
 * - D: B, but from 9 km it swings another 1 km north until 14 km.
 * - BA: B as far as 10 km, then back down to A.
 * - E: A, with a short loop north between 18.5 and 19.5 km.
 */
export const CORNERS = {
  A: [[0, 0], [20000, 0]],
  B: [[0, 0], [5000, 0], [5000, 1000], [15000, 1000], [15000, 0], [20000, 0]],
  C: [[0, 0], [8000, 0], [8000, -1000], [12000, -1000], [12000, 0], [20000, 0]],
  D: [[0, 0], [5000, 0], [5000, 1000], [9000, 1000], [9000, 2000], [14000, 2000], [14000, 1000], [15000, 1000], [15000, 0], [20000, 0]],
  BA: [[0, 0], [5000, 0], [5000, 1000], [10000, 1000], [10000, 0], [20000, 0]],
  E: [[0, 0], [18500, 0], [18500, 300], [19500, 300], [19500, 0], [20000, 0]],
} as const satisfies Record<string, readonly Corner[]>

export type RouteName = keyof typeof CORNERS
export const ROUTE_NAMES = Object.keys(CORNERS) as RouteName[]

const LINES = Object.fromEntries(ROUTE_NAMES.map((name) => [name, road(CORNERS[name])])) as unknown as Record<
  RouteName,
  LngLat[]
>

/** Where on a line the point lies, in meters from the line's start. Null when it is more than a meter off it. */
function alongOf(line: readonly LngLat[], point: LngLat): number | null {
  const project = localProjector(point)
  const xy = line.map(project)
  const along = alongRouteM(line)
  for (let i = 1; i < xy.length; i++) {
    const hit = pointToSegment([0, 0], xy[i - 1]!, xy[i]!)
    if (hit.distanceM <= 1) return along[i - 1]! + hit.t * (along[i]! - along[i - 1]!)
  }
  return null
}

let pollCounter = 0

/**
 * The route `name` as a directions query from `from` would return it: the
 * rest of the route from that point, a maneuver at each corner still ahead,
 * and an id that is new on every call (ids must never be relied on between
 * polls). Null when the point is not on the route.
 */
export function candidate(
  name: RouteName,
  from: LngLat,
  durationSec: number,
  extra: Partial<RouteCandidate> = {},
): RouteCandidate | null {
  const full = LINES[name]
  const fromM = alongOf(full, from)
  if (fromM === null) return null
  const geometry = lineFrom(full, fromM)
  if (geometry.length < 2) return null
  const maneuvers: Maneuver[] = [{ atDistanceM: 0, kind: 'depart', location: geometry[0]! }]
  for (const [x, y] of CORNERS[name].slice(1, -1)) {
    const cornerM = alongOf(full, at(x, y))!
    if (cornerM > fromM) maneuvers.push({ atDistanceM: cornerM - fromM, kind: 'turn', location: at(x, y) })
  }
  const distanceM = alongRouteM(geometry).at(-1)!
  maneuvers.push({ atDistanceM: distanceM, kind: 'arrive', location: geometry.at(-1)! })
  return {
    id: `${name}-${++pollCounter}`,
    geometry,
    durationSec,
    typicalDurationSec: durationSec,
    distanceM,
    signalCount: null,
    signalCoverage: 'none',
    providerSignalCount: null,
    intersections: null,
    limitedAccessSpansM: [],
    maneuvers,
    ...extra,
  }
}

/** The route name a candidate made here was built from. */
export const nameOf = (route: Pick<RouteCandidate, 'id'>) => route.id.split('-')[0] as RouteName

export interface PollContext {
  /** 0 for the first poll. */
  readonly poll: number
  readonly nowSec: number
  /** The route being driven. */
  readonly on: RouteName
  /** Where the driver is. */
  readonly position: LngLat
}

export interface DriveScript {
  /** The route the drive starts on, and how far along it. */
  readonly start?: RouteName
  readonly startAlongM?: number
  readonly speedMps?: number
  readonly pollEverySec?: number
  readonly polls: number
  /**
   * The ETA of each route at a poll, in seconds, or null when the route is
   * not offered. Asked only for routes the driver could still take.
   */
  readonly eta: (name: RouteName, context: PollContext) => number | null
  /** Changes a poll's candidates before the engine sees them; null makes the poll fail. */
  readonly tamper?: (candidates: RouteCandidate[], context: PollContext) => readonly RouteCandidate[] | null
  /**
   * What a request for the current path itself answers at a poll (RerouteObservation.baseline),
   * given the poll's candidates. Left out, or null: not asked.
   */
  readonly baseline?: (candidates: readonly RouteCandidate[], context: PollContext) => readonly RouteCandidate[] | null
  readonly options?: Partial<RerouteOptions>
}

export interface PollRecord {
  readonly nowSec: number
  readonly on: RouteName
  readonly decision: RerouteDecision
  /** The state the engine was handed for this poll. */
  readonly stateBefore: RerouteState
}

export interface DriveLog {
  readonly polls: readonly PollRecord[]
  /** The polls that switched, in order. */
  readonly switches: readonly { readonly nowSec: number; readonly from: RouteName; readonly to: RouteName }[]
  readonly codes: readonly string[]
  readonly finalState: RerouteState
}

/**
 * Drives the network on a fake clock: every `pollEverySec` the driver has
 * moved `speedMps` x that far along the current route, a "directions query"
 * returns the routes still open from there, and the engine decides. A switch
 * is applied the way an app would: the chosen candidate becomes the route.
 * No network, no timers, no randomness.
 */
export function drive(script: DriveScript): DriveLog {
  const { start = 'A', startAlongM = 0, speedMps = 5, pollEverySec = 60, polls, eta, tamper, baseline, options = {} } = script
  let on: RouteName = start
  let route: Pick<RouteCandidate, 'geometry' | 'maneuvers' | 'limitedAccessSpansM'> = {
    geometry: LINES[start],
    maneuvers: [],
    limitedAccessSpansM: null,
  }
  let alongM = startAlongM
  let state = INITIAL_REROUTE_STATE
  const records: PollRecord[] = []
  const switches: { nowSec: number; from: RouteName; to: RouteName }[] = []

  for (let poll = 0; poll < polls; poll++) {
    const nowSec = poll * pollEverySec
    if (poll > 0) alongM += speedMps * pollEverySec
    const here = pointAtDistance(route.geometry, alongM)
    if (here === null || alongM >= alongRouteM(route.geometry).at(-1)!) break
    const context: PollContext = { poll, nowSec, on, position: here.point }

    // The current route first, so that of two names with the same road ahead it is the one kept.
    const offered: RouteCandidate[] = []
    for (const name of [on, ...ROUTE_NAMES.filter((n) => n !== on)]) {
      const sec = eta(name, context)
      if (sec === null) continue
      const made = candidate(name, here.point, sec)
      if (made === null) continue
      const sameRoadAhead = offered.some(
        (o) =>
          o.geometry.length === made.geometry.length &&
          o.geometry.every((p, i) => Math.hypot(p[0] - made.geometry[i]![0], p[1] - made.geometry[i]![1]) < 1e-9),
      )
      if (!sameRoadAhead) offered.push(made)
    }
    const candidates = tamper ? tamper(offered, context) : offered

    const asked = candidates === null || baseline === undefined ? null : baseline(candidates, context)
    const decision = decideReroute(state, { nowSec, route, positionAlongM: alongM, speedMps, candidates, baseline: asked }, options)
    records.push({ nowSec, on, decision, stateBefore: state })
    state = decision.nextState
    if (decision.action === 'switch') {
      const to = candidates!.find((c) => c.id === decision.toRouteId)!
      switches.push({ nowSec, from: on, to: nameOf(to) })
      on = nameOf(to)
      route = to
      alongM = 0
    }
  }
  return { polls: records, switches, codes: records.map((r) => r.decision.code), finalState: state }
}
