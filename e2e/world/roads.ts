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
// How long each stretch takes is set by a Traffic function, so a scenario can
// script "a jam on A from the third request on" without touching the geometry.
// Nothing here is a real road or a real place; only O and D are, and those
// come from the app (public landmarks in the scenarios).

export type LngLat = [number, number]
export type RouteName = 'A' | 'B' | 'C' | 'off-route'

/** A point in the trip's own frame: `f` is the share of the way from O to D, `side` is meters to the left (+) or right (-). */
export interface FramePoint {
  readonly f: number
  readonly side: number
}

/** Seconds per meter on a stretch of `route` around `at`, for the `n`th Directions request of the test (1 is the first). */
export type Traffic = (route: RouteName, at: FramePoint, n: number) => number

// A is the fastest by about a minute in free flow, more than the 30 s within which
// the signal count breaks ties, so the recommended route is always A.
const BASE_PACE: Record<RouteName, number> = { A: 1 / 22, B: 1 / 23, C: 1 / 22.5, 'off-route': 1 / 12 }

/** Free-flowing traffic everywhere: each route at its usual pace. */
export const FREE_FLOW: Traffic = (route) => BASE_PACE[route]

const ROAD_NAMES: Record<RouteName, string> = {
  A: 'Main Corridor',
  B: 'East Loop',
  C: 'West Loop',
  'off-route': 'Side Street',
}

// Corners as (share of the trip, meters to the left). Detours scale down on short trips.
const CORNERS: Record<'A' | 'B' | 'C', readonly (readonly [number, number])[]> = {
  A: [[0, 0], [0.25, 0], [0.25, 300], [0.75, 300], [0.75, 0], [1, 0]],
  B: [[0, 0], [0.25, 0], [0.25, 300], [0.4, 300], [0.4, 1500], [0.85, 1500], [0.85, 0], [1, 0]],
  C: [[0, 0], [0.25, 0], [0.25, 300], [0.55, 300], [0.55, -1200], [0.9, -1200], [0.9, 0], [1, 0]],
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

  constructor(origin: LngLat, destination: LngLat) {
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
    this.roads = (['A', 'B', 'C'] as const).map((name) => {
      const corners = CORNERS[name].map(([f, side], i, all) =>
        i === 0 ? origin : i === all.length - 1 ? destination : at(f, side),
      )
      // Stretches on A's line carry A's names, so a turn is announced the same on every route.
      const legNames = corners.slice(0, -1).map((_, i) => {
        const [f, side] = CORNERS[name][i]!
        const [f2, side2] = CORNERS[name][i + 1]!
        const alongA = side === side2 && (side === 0 || side === 300)
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
  cornersOf(name: 'A' | 'B' | 'C'): readonly LngLat[] {
    return this.road(name).corners
  }

  /** The routes on offer from `from`, as Mapbox Directions JSON, fastest first. */
  directions(from: LngLat, traffic: Traffic, n: number): DirectionsJson {
    const offered: { road: Road; body: RouteJson }[] = []
    for (const road of this.roads) {
      const p = project(this.frame, road.corners, from)
      if (p.offM > ON_ROAD_M) continue
      const rest = restOf(road, p)
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

  private road(name: 'A' | 'B' | 'C'): Road {
    return this.roads.find((r) => r.name === name)!
  }

  private routeJson(road: Road, traffic: Traffic, n: number): RouteJson {
    const line: LngLat[] = []
    const steps: StepJson[] = []
    let duration = 0
    let typical = 0
    let distance = 0
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
        const paceOf: RouteName = road.name === 'off-route' && i > 0 ? 'A' : road.name
        stepSec += m * traffic(paceOf, mid, n)
        typical += m * BASE_PACE[paceOf]
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
      legs: [{ distance: round1(distance), duration: round1(duration), summary: road.legNames[0] ?? '', steps }],
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
  legs: { distance: number; duration: number; summary: string; steps: StepJson[] }[]
}
export interface DirectionsJson {
  code: 'Ok'
  uuid: string
  waypoints: never[]
  routes: RouteJson[]
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
