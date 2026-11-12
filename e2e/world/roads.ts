// A made-up road network that answers Mapbox Directions requests offline.
//
// Between any trip origin O and destination D it lays out three routes that
// share their start and end and differ in the middle, the way real
// alternatives do:
//
//   A  "Main Corridor": the direct one, with a jog in the middle.
//   B  "East Loop":     follows A to 40 % of the trip, swings east, rejoins A near the end.
//   C  "West Loop":     follows A to 55 % of the trip, swings west, rejoins A near the end.
//
// A request from anywhere along a route (a car mid-drive) is answered with the
// rest of every route that passes that point, starting at the point on the
// road nearest the car, as Mapbox does. A request from off every route (a wrong
// turn) gets a short connector back onto A, then the rest of A.
//
//   S  "Parallel Street": a side street Mapbox never offers among its three. Where A
//      jogs 300 m east for the middle half of the trip, S keeps straight on, so it is
//      shorter but slower in free flow. It exists only in a world made with
//      `{ sideStreet: true }`, and only a request with a via point (a side-street probe,
//      see `through`) can reach it.
//
// A request with a via point is answered the way Mapbox snaps a via onto the
// nearest road: one route along whichever road passes closest to the via (so a
// via beside A comes back as A itself), or NoSegment when no road is near.
//
// How long each stretch takes is set by a Traffic function, so a scenario can
// script "a jam on A from the third request on" without touching the geometry.
// A Closure, likewise, closes stretches of road from some request on: a route
// whose way ahead passes a closed stretch is not offered, and a request through
// via points on it is answered NoRoute, as Mapbox answers when no road goes that way.
// Every answer carries Mapbox's per-segment annotations (congestion and
// duration, one entry per segment of the line), the congestion read off how much
// slower the segment is than its usual pace (see congestionOf).
// Nothing here is a real road or a real place; only O and D are, and those
// come from the app (public landmarks in the scenarios).

export type LngLat = [number, number]
export type RouteName = 'A' | 'B' | 'C' | 'S' | 'off-route'
export type RoadName = 'A' | 'B' | 'C' | 'S'

/** A point in the trip's own frame: `f` is the share of the way from O to D, `side` is meters to the left (+) or right (-). */
export interface FramePoint {
  readonly f: number
  readonly side: number
}

/** Seconds per meter on a stretch of `route` around `at`, for the `n`th Directions request of the test (1 is the first). */
export type Traffic = (route: RouteName, at: FramePoint, n: number) => number

/** True when the road at `at` is closed for the `n`th Directions request of the test. */
export type Closure = (at: FramePoint, n: number) => boolean

/** Nothing is ever closed. */
export const NO_CLOSURES: Closure = () => false

// A is the fastest by about a minute in free flow, more than the 30 s within which
// the signal count breaks ties, so the recommended route is always A.
// S's own stretch (the middle half, where it leaves A) is a slower street: in free
// flow S is about 1.5 minutes behind A and last of all four.
const BASE_PACE: Record<RouteName, number> = { A: 1 / 22, B: 1 / 23, C: 1 / 22.5, S: 1 / 18, 'off-route': 1 / 12 }

/**
 * Mapbox's congestion word for a segment driven at `ratio` times its usual pace.
 * Made up for this world: Mapbox does not publish how it buckets live speeds.
 */
export function congestionOf(ratio: number): 'low' | 'moderate' | 'heavy' | 'severe' {
  if (ratio >= 3) return 'severe'
  if (ratio >= 1.75) return 'heavy'
  if (ratio >= 1.25) return 'moderate'
  return 'low'
}

/** Free-flowing traffic everywhere: each route at its usual pace. */
export const FREE_FLOW: Traffic = (route) => BASE_PACE[route]

const ROAD_NAMES: Record<RouteName, string> = {
  A: 'Main Corridor',
  B: 'East Loop',
  C: 'West Loop',
  S: 'Parallel Street',
  'off-route': 'Side Street',
}

// Corners as (share of the trip, meters to the left). Detours scale down on short trips.
const CORNERS: Record<RoadName, readonly (readonly [number, number])[]> = {
  A: [[0, 0], [0.25, 0], [0.25, 300], [0.75, 300], [0.75, 0], [1, 0]],
  B: [[0, 0], [0.25, 0], [0.25, 300], [0.4, 300], [0.4, 1500], [0.85, 1500], [0.85, 0], [1, 0]],
  C: [[0, 0], [0.25, 0], [0.25, 300], [0.55, 300], [0.55, -1200], [0.9, -1200], [0.9, 0], [1, 0]],
  S: [[0, 0], [0.25, 0], [0.75, 0], [1, 0]],
}

/** Mapbox's own answer: the three routes it offers. S is never among them. */
const OFFERED: readonly RoadName[] = ['A', 'B', 'C']

/** A via point farther than this from every road gets NoSegment (Mapbox's snapping radius stand-in). */
const VIA_SNAP_M = 1000

/** Where a route runs along A's line: A's own stretches, whichever route drives them. */
function onA(f: number, f2: number, side: number, side2: number): boolean {
  if (side !== side2) return false
  if (side === 300) return f >= 0.25 && f2 <= 0.75
  return side === 0 && (f2 <= 0.25 || f >= 0.75)
}

const M_PER_DEG = 111_195

interface Frame {
  readonly toXY: (p: LngLat) => readonly [number, number]
  readonly toLngLat: (x: number, y: number) => LngLat
  readonly toFrame: (p: LngLat) => FramePoint
  readonly lengthM: number
}

function frameOf(o: LngLat, d: LngLat): Frame {
  const kx = M_PER_DEG * Math.cos((o[1] * Math.PI) / 180)
  const toXY = (p: LngLat) => [(p[0] - o[0]) * kx, (p[1] - o[1]) * M_PER_DEG] as const
  const [dx, dy] = toXY(d)
  const lengthM = Math.hypot(dx, dy)
  const ux = dx / lengthM
  const uy = dy / lengthM
  return {
    lengthM,
    toXY,
    toLngLat: (x, y) => [round6(o[0] + x / kx), round6(o[1] + y / M_PER_DEG)],
    toFrame: (p) => {
      const [x, y] = toXY(p)
      return { f: (x * ux + y * uy) / lengthM, side: -x * uy + y * ux }
    },
  }
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6

/** A road as corner points, each corner a maneuver, the last one the destination. */
interface Road {
  readonly name: RouteName
  readonly corners: readonly LngLat[]
  /** The road name leaving each corner (one per corner but the last). */
  readonly legNames: readonly string[]
}

interface Projection {
  /** Index of the corner the segment starts at. */
  readonly segment: number
  readonly point: LngLat
  readonly offM: number
  readonly alongM: number
}

export class World {
  readonly origin: LngLat
  readonly destination: LngLat
  private readonly frame: Frame
  private readonly roads: readonly Road[]

  private readonly sideStreet: boolean

  constructor(origin: LngLat, destination: LngLat, options: { sideStreet?: boolean } = {}) {
    this.sideStreet = options.sideStreet === true
    this.origin = origin
    this.destination = destination
    this.frame = frameOf(origin, destination)
    // Detours of 1.5 km make no sense on a 2 km trip: scale them with the trip.
    const scale = Math.min(1, this.frame.lengthM / 20_000)
    const [dx, dy] = this.frame.toXY(destination)
    const ux = dx / this.frame.lengthM
    const uy = dy / this.frame.lengthM
    const at = (f: number, side: number): LngLat => {
      const along = f * this.frame.lengthM
      const s = side * scale
      return this.frame.toLngLat(along * ux - s * uy, along * uy + s * ux)
    }
    this.roads = (['A', 'B', 'C', 'S'] as const).map((name) => {
      const corners = CORNERS[name].map(([f, side], i, all) =>
        i === 0 ? origin : i === all.length - 1 ? destination : at(f, side),
      )
      // Stretches on A's line carry A's names, so a turn is announced the same on every route.
      const legNames = corners.slice(0, -1).map((_, i) => {
        const [f, side] = CORNERS[name][i]!
        const [f2, side2] = CORNERS[name][i + 1]!
        const alongA = onA(f, f2, side, side2)
        const acrossA = f === f2 && (f === 0.25 || f === 0.75) && Math.max(Math.abs(side), Math.abs(side2)) <= 300
        if (alongA) return ROAD_NAMES.A
        if (acrossA) return 'Cross Street'
        return ROAD_NAMES[name]
      })
      return { name, corners, legNames }
    })
  }

  /** The trip's frame position of a point, for Traffic functions and tests. */
  frameOf(p: LngLat): FramePoint {
    return this.frame.toFrame(p)
  }

  /** The full corner list of a route, for driving it. */
  cornersOf(name: RoadName): readonly LngLat[] {
    return this.road(name).corners
  }

  /** The routes on offer from `from`, as Mapbox Directions JSON, fastest first. */
  directions(from: LngLat, traffic: Traffic, n: number, closed: Closure = NO_CLOSURES): DirectionsJson {
    const offered: { road: Road; body: RouteJson }[] = []
    for (const road of this.roads) {
      if (!OFFERED.includes(road.name as RoadName)) continue
      const p = project(this.frame, road.corners, from)
      if (p.offM > ON_ROAD_M) continue
      const rest = restOf(road, p)
      if (this.isClosed(rest, closed, n)) continue
      offered.push({ road: rest, body: this.routeJson(rest, traffic, n) })
    }
    if (offered.length === 0) {
      // A wrong turn: a side street back onto A, 600 m further on.
      const a = this.road('A')
      const p = project(this.frame, a.corners, from)
      const back = pointAlong(this.frame, a.corners, p.alongM + 600)
      const rest = restOf(a, back)
      const road: Road = {
        name: 'off-route',
        corners: [from, ...rest.corners],
        legNames: [ROAD_NAMES['off-route'], ...rest.legNames],
      }
      offered.push({ road, body: this.routeJson(road, traffic, n) })
    }
    offered.sort((x, y) => x.body.duration - y.body.duration)
    this.lastOffered = offered.map(({ road, body }) => ({ name: road.name, corners: road.corners, durationSec: body.duration }))
    return { code: 'Ok', uuid: 'e2e-made-up-road-network', waypoints: [], routes: offered.map((o) => o.body) }
  }

  /** What the last answer offered, fastest first: what a driver who follows the app ends up driving. */
  lastOffered: readonly { name: RouteName; corners: readonly LngLat[]; durationSec: number }[] = []

  /**
   * The answer to a request from `from` through `via` (a side-street probe):
   * one route along the road that passes nearest the via, as Mapbox snaps a
   * via onto the road network, from the point on it nearest `from`. A car
   * that is not on that road (a probe during a drive) first drives a cross
   * street straight over to it. A via next
   * to a road Mapbox already offered comes back as that road. NoSegment when
   * no road is within VIA_SNAP_M. S is a road only in a world made with
   * `sideStreet`. Leaves lastOffered alone: a probe is not what the car drives.
   */
  through(
    from: LngLat,
    via: LngLat,
    traffic: Traffic,
    n: number,
    /** The via's `radiuses` entry, when the request sent one: no road this close is NoSegment, as at Mapbox. */
    radiusM: number = VIA_SNAP_M,
    closed: Closure = NO_CLOSURES,
  ): { answer: DirectionsJson | NoSegmentJson | NoRouteJson; road: RouteName | null; durationSec: number | null } {
    let best: { road: Road; offM: number } | null = null
    for (const road of this.roads) {
      if (road.name === 'S' && !this.sideStreet) continue
      const offM = project(this.frame, road.corners, via).offM
      if (best === null || offM < best.offM - 0.01) best = { road, offM }
    }
    if (best === null || best.offM > Math.min(VIA_SNAP_M, radiusM)) {
      return { answer: { code: 'NoSegment', message: 'Could not find a matching segment for input coordinates', routes: [] }, road: null, durationSec: null }
    }
    const onRoad = project(this.frame, best.road.corners, from)
    const rest = restOf(best.road, onRoad)
    const road: Road =
      onRoad.offM <= ON_ROAD_M ? rest : { name: rest.name, corners: [from, ...rest.corners], legNames: ['Cross Street', ...rest.legNames] }
    if (this.isClosed(road, closed, n)) return { answer: NO_ROUTE, road: null, durationSec: null }
    const body = this.routeJson(road, traffic, n)
    return { answer: { code: 'Ok', uuid: 'e2e-made-up-road-network', waypoints: [], routes: [body] }, road: road.name, durationSec: body.duration }
  }

  /**
   * The answer to the drive's own check of the route being driven (core
   * baselineProbe): from `from` through via points along that route, which
   * the drive places where it leaves the routes Mapbox offered. One route
   * along the road that passes within ON_ROAD_M of every via (S only in a
   * world made with `sideStreet`), from the point on it nearest `from`. Null
   * when no one road passes them all. NoRoute (road null) when that road is
   * closed on the way. Leaves lastOffered alone: the car drives on what it was
   * driving.
   */
  pathThrough(
    from: LngLat,
    vias: readonly LngLat[],
    traffic: Traffic,
    n: number,
    closed: Closure = NO_CLOSURES,
  ): { answer: DirectionsJson | NoRouteJson; road: RouteName | null; durationSec: number | null } | null {
    for (const road of this.roads) {
      if (road.name === 'S' && !this.sideStreet) continue
      if (!vias.every((via) => project(this.frame, road.corners, via).offM <= ON_ROAD_M)) continue
      const rest = restOf(road, project(this.frame, road.corners, from))
      if (this.isClosed(rest, closed, n)) return { answer: NO_ROUTE, road: null, durationSec: null }
      const body = this.routeJson(rest, traffic, n)
      return { answer: { code: 'Ok', uuid: 'e2e-made-up-road-network', waypoints: [], routes: [body] }, road: road.name, durationSec: body.duration }
    }
    return null
  }

  /** True when some stretch of `road` (from its first corner to its last) is closed for request `n`. */
  private isClosed(road: Road, closed: Closure, n: number): boolean {
    if (closed === NO_CLOSURES) return false
    for (let i = 0; i < road.corners.length - 1; i++) {
      const piece = densify(this.frame, road.corners[i]!, road.corners[i + 1]!)
      for (let k = 1; k < piece.length; k++) {
        const mid = this.frame.toFrame([(piece[k - 1]![0] + piece[k]![0]) / 2, (piece[k - 1]![1] + piece[k]![1]) / 2])
        if (closed(mid, n)) return true
      }
    }
    return false
  }

  private road(name: RoadName): Road {
    return this.roads.find((r) => r.name === name)!
  }

  private routeJson(road: Road, traffic: Traffic, n: number): RouteJson {
    const line: LngLat[] = []
    const steps: StepJson[] = []
    let duration = 0
    let typical = 0
    let distance = 0
    const congestion: string[] = []
    const segmentSec: number[] = []
    const corners = road.corners
    for (let i = 0; i < corners.length - 1; i++) {
      const a = corners[i]!
      const b = corners[i + 1]!
      const piece = densify(this.frame, a, b)
      const startIndex = line.length === 0 ? 0 : line.length - 1
      if (line.length === 0) line.push(piece[0]!)
      line.push(...piece.slice(1))
      let stepM = 0
      let stepSec = 0
      for (let k = 1; k < piece.length; k++) {
        const m = distM(this.frame, piece[k - 1]!, piece[k]!)
        const mid = this.frame.toFrame([(piece[k - 1]![0] + piece[k]![0]) / 2, (piece[k - 1]![1] + piece[k]![1]) / 2])
        stepM += m
        // A way back after a wrong turn is a slow side street, then A again.
        // S drives A's own road before and after its middle half.
        const onSharedA = road.name === 'S' && (mid.f < 0.25 || mid.f > 0.75)
        const paceOf: RouteName = (road.name === 'off-route' && i > 0) || onSharedA ? 'A' : road.name
        const pace = traffic(paceOf, mid, n)
        stepSec += m * pace
        typical += m * BASE_PACE[paceOf]
        congestion.push(congestionOf(pace / BASE_PACE[paceOf]))
        segmentSec.push(round1(m * pace))
      }
      duration += stepSec
      distance += stepM
      const turn = i === 0 ? null : turnOf(this.frame, corners[i - 1]!, a, b)
      const name = road.legNames[i]!
      const next = i + 1 < corners.length - 1 ? turnOf(this.frame, a, b, corners[i + 2]!) : null
      const nextName = road.legNames[i + 1] ?? ''
      steps.push({
        distance: round1(stepM),
        duration: round1(stepSec),
        name,
        maneuver: {
          type: i === 0 ? 'depart' : 'turn',
          ...(turn === null ? {} : { modifier: turn }),
          location: a,
          instruction: i === 0 ? `Drive along ${name}` : turn === 'straight' ? `Continue onto ${name}` : `Turn ${turn} onto ${name}`,
        },
        intersections: intersectionsOf(piece, startIndex),
        bannerInstructions:
          next === null
            ? [{ distanceAlongGeometry: round1(stepM), primary: { text: 'Your destination', type: 'arrive', modifier: 'straight' } }]
            : [{ distanceAlongGeometry: round1(stepM), primary: { text: nextName, type: 'turn', modifier: next } }],
        voiceInstructions: voiceFor(stepM, next, nextName),
      })
    }
    steps.push({
      distance: 0,
      duration: 0,
      name: road.legNames.at(-1) ?? '',
      maneuver: { type: 'arrive', location: corners.at(-1)!, instruction: 'You have arrived at your destination' },
      intersections: [{ location: corners.at(-1)!, geometry_index: line.length - 1 }],
      bannerInstructions: [],
      voiceInstructions: [],
    })
    return {
      weight_name: 'auto',
      weight: round1(duration),
      duration: round1(duration),
      duration_typical: round1(typical),
      distance: round1(distance),
      geometry: { type: 'LineString', coordinates: line },
      legs: [
        {
          distance: round1(distance),
          duration: round1(duration),
          summary: road.legNames[0] ?? '',
          steps,
          annotation: { congestion, duration: segmentSec },
        },
      ],
    }
  }
}

/** A car this far from a road is on it (GPS noise and snapping). */
const ON_ROAD_M = 40
/** Route vertices are about this far apart, as on a real route. */
const VERTEX_M = 250
/** A flagged signal about this often on every road. */
const SIGNAL_EVERY = 6

const round1 = (v: number) => Math.round(v * 10) / 10

function distM(frame: Frame, a: LngLat, b: LngLat): number {
  const [ax, ay] = frame.toXY(a)
  const [bx, by] = frame.toXY(b)
  return Math.hypot(bx - ax, by - ay)
}

function densify(frame: Frame, a: LngLat, b: LngLat): LngLat[] {
  const n = Math.max(1, Math.round(distM(frame, a, b) / VERTEX_M))
  const [ax, ay] = frame.toXY(a)
  const [bx, by] = frame.toXY(b)
  const out: LngLat[] = [a]
  for (let k = 1; k < n; k++) out.push(frame.toLngLat(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n))
  out.push(b)
  return out
}

function project(frame: Frame, corners: readonly LngLat[], p: LngLat): Projection {
  const [px, py] = frame.toXY(p)
  let best: Projection | null = null
  let along = 0
  for (let i = 0; i < corners.length - 1; i++) {
    const [ax, ay] = frame.toXY(corners[i]!)
    const [bx, by] = frame.toXY(corners[i + 1]!)
    const len = Math.hypot(bx - ax, by - ay)
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / (len * len)))
    const qx = ax + (bx - ax) * t
    const qy = ay + (by - ay) * t
    const off = Math.hypot(px - qx, py - qy)
    if (best === null || off < best.offM - 0.01)
      best = { segment: i, point: frame.toLngLat(qx, qy), offM: off, alongM: along + len * t }
    along += len
  }
  return best!
}

function pointAlong(frame: Frame, corners: readonly LngLat[], alongM: number): Projection {
  let left = alongM
  for (let i = 0; i < corners.length - 1; i++) {
    const len = distM(frame, corners[i]!, corners[i + 1]!)
    if (left <= len || i === corners.length - 2) {
      const [ax, ay] = frame.toXY(corners[i]!)
      const [bx, by] = frame.toXY(corners[i + 1]!)
      const t = len === 0 ? 0 : Math.min(1, left / len)
      return { segment: i, point: frame.toLngLat(ax + (bx - ax) * t, ay + (by - ay) * t), offM: 0, alongM }
    }
    left -= len
  }
  return { segment: 0, point: corners[0]!, offM: 0, alongM: 0 }
}

/** The road from a point on it to its end. */
function restOf(road: Road, p: Projection): Road {
  const after = road.corners.slice(p.segment + 1)
  const startsOnCorner = after[0] !== undefined && after[0][0] === p.point[0] && after[0][1] === p.point[1]
  return {
    name: road.name,
    corners: startsOnCorner ? after : [p.point, ...after],
    legNames: startsOnCorner ? road.legNames.slice(p.segment + 1) : road.legNames.slice(p.segment),
  }
}

/** "right", "left" or "straight" for the turn at `b` coming from `a` and going to `c`. */
function turnOf(frame: Frame, a: LngLat, b: LngLat, c: LngLat): 'left' | 'right' | 'straight' {
  const [ax, ay] = frame.toXY(a)
  const [bx, by] = frame.toXY(b)
  const [cx, cy] = frame.toXY(c)
  const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
  const dot = (bx - ax) * (cx - bx) + (by - ay) * (cy - by)
  const angle = Math.abs(Math.atan2(cross, dot))
  if (angle < Math.PI / 8) return 'straight'
  return cross > 0 ? 'left' : 'right'
}

function intersectionsOf(piece: readonly LngLat[], startIndex: number): IntersectionJson[] {
  return piece.slice(0, -1).map((location, k) => ({
    location,
    geometry_index: startIndex + k,
    ...((startIndex + k) % SIGNAL_EVERY === 3 ? { traffic_signal: true } : {}),
  }))
}

function voiceFor(stepM: number, next: 'left' | 'right' | 'straight' | null, nextName: string): VoiceJson[] {
  if (next === null) {
    return [{ distanceAlongGeometry: Math.min(stepM, 150), announcement: 'Your destination is ahead.' }]
  }
  const now = next === 'straight' ? `Continue onto ${nextName}.` : `Turn ${next} onto ${nextName}.`
  const out: VoiceJson[] = []
  if (stepM > 1200) out.push({ distanceAlongGeometry: 800, announcement: `In half a mile, ${now.charAt(0).toLowerCase()}${now.slice(1)}` })
  out.push({ distanceAlongGeometry: Math.min(stepM, 80), announcement: now })
  return out
}

// The parts of the Directions v5 response RouteIQ reads (see src/providers/mapbox/adapter.ts).
interface VoiceJson {
  distanceAlongGeometry: number
  announcement: string
}
interface IntersectionJson {
  location: LngLat
  geometry_index: number
  traffic_signal?: true
}
interface StepJson {
  distance: number
  duration: number
  name: string
  maneuver: { type: string; modifier?: string; location: LngLat; instruction: string }
  intersections: IntersectionJson[]
  bannerInstructions: { distanceAlongGeometry: number; primary: { text: string; type: string; modifier: string } }[]
  voiceInstructions: VoiceJson[]
}
export interface RouteJson {
  weight_name: string
  weight: number
  duration: number
  duration_typical: number
  distance: number
  geometry: { type: 'LineString'; coordinates: LngLat[] }
  legs: {
    distance: number
    duration: number
    summary: string
    steps: StepJson[]
    /** Sent with annotations=congestion,duration: one entry per segment of `geometry`. */
    annotation: { congestion: string[]; duration: number[] }
  }[]
}
export interface DirectionsJson {
  code: 'Ok'
  uuid: string
  waypoints: never[]
  routes: RouteJson[]
}
/** Mapbox's answer (HTTP 200) when no road goes from the start through the points to the end. */
export interface NoRouteJson {
  code: 'NoRoute'
  message: string
  routes: never[]
}
const NO_ROUTE: NoRouteJson = { code: 'NoRoute', message: 'No route found', routes: [] }

/** Mapbox's answer (HTTP 200) when a coordinate is too far from any road. */
export interface NoSegmentJson {
  code: 'NoSegment'
  message: string
  routes: never[]
}

/** The point `alongM` meters along a corner list and the heading there, for the fake GPS. */
export function along(corners: readonly LngLat[], alongM: number): { point: LngLat; headingDeg: number; atEnd: boolean } {
  const frame = frameOf(corners[0]!, corners.at(-1)!)
  const p = pointAlong(frame, corners, alongM)
  const a = corners[p.segment]!
  const b = corners[p.segment + 1] ?? a
  const [ax, ay] = frame.toXY(a)
  const [bx, by] = frame.toXY(b)
  const headingDeg = ((Math.atan2(bx - ax, by - ay) * 180) / Math.PI + 360) % 360
  const total = corners.slice(1).reduce((sum, c, i) => sum + distM(frame, corners[i]!, c), 0)
  return { point: p.point, headingDeg, atEnd: alongM >= total }
}

/** How far along a corner list the point nearest `p` is, in meters. */
export function alongOf(corners: readonly LngLat[], p: LngLat): number {
  return project(frameOf(corners[0]!, corners.at(-1)!), corners, p).alongM
}

/** The point `meters` to the left (+) or right (-) of `p`, square to `headingDeg`. */
export function sideStep(p: LngLat, headingDeg: number, meters: number): LngLat {
  const kx = M_PER_DEG * Math.cos((p[1] * Math.PI) / 180)
  const h = (headingDeg * Math.PI) / 180
  // Left of a heading (east of north = 0) is heading - 90.
  const x = -Math.cos(h) * meters
  const y = Math.sin(h) * meters
  return [round6(p[0] + x / kx), round6(p[1] + y / M_PER_DEG)]
}
