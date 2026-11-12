import type { BBox, LngLat } from './types.ts'

export function isValidLngLat([lng, lat]: LngLat): boolean {
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  )
}

/** Smallest box that holds every point. Throws on an empty or invalid list. */
export function boundsOf(points: readonly LngLat[]): BBox {
  if (points.length === 0) throw new Error('boundsOf needs at least one point')
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const p of points) {
    if (!isValidLngLat(p)) throw new Error(`Invalid coordinate: ${p.join(',')}`)
    const [lng, lat] = p
    west = Math.min(west, lng)
    east = Math.max(east, lng)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  return [west, south, east, north]
}

const EARTH_RADIUS_M = 6_371_008.8

/** Great-circle distance in meters (haversine). */
export function distanceM(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Distance from the start of a polyline to each of its points, in meters
 * (great-circle, summed segment by segment). The result has one entry per
 * point and starts at 0. This is the "meters along the route" that distance
 * spans on a RouteCandidate use; the flat plane the signal matching works on
 * agrees with it to a few meters over a city-length route.
 */
export function alongRouteM(line: readonly LngLat[]): number[] {
  const along: number[] = []
  let total = 0
  line.forEach((p, i) => {
    if (i > 0) total += distanceM(line[i - 1]!, p)
    along.push(total)
  })
  return along
}

/** Meters in one degree of latitude (and of longitude at the equator). */
export const M_PER_DEGREE = (EARTH_RADIUS_M * Math.PI) / 180

/**
 * Degrees of longitude that span as much ground as `latDegrees` of latitude,
 * at latitude `lat`. A degree of longitude shrinks toward the poles; the floor
 * near them keeps the answer finite.
 */
export function lngDegreesFor(latDegrees: number, lat: number): number {
  return latDegrees / Math.max(0.01, Math.cos((Math.min(89.9, Math.abs(lat)) * Math.PI) / 180))
}

/** A point on a flat local plane, in meters east (x) and north (y) of the plane's origin. */
export type XY = readonly [x: number, y: number]

/**
 * Equirectangular projection around `origin`: fast, and accurate to well under
 * a meter per kilometer at city scale, which is all the signal matching needs.
 * Not for routes that cross the antimeridian or run near a pole.
 */
export function localProjector(origin: LngLat): (p: LngLat) => XY {
  const [lng0, lat0] = origin
  const mPerDegreeLng = M_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180)
  return ([lng, lat]) => [(lng - lng0) * mPerDegreeLng, (lat - lat0) * M_PER_DEGREE]
}

/**
 * Closest approach of point P to the segment A-B on a flat plane.
 * `t` is where along the segment the closest point lies, from 0 (at A) to 1 (at B).
 * A zero-length segment is treated as the point A.
 */
export function pointToSegment(p: XY, a: XY, b: XY): { distanceM: number; t: number } {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSq = dx * dx + dy * dy
  const t =
    lengthSq === 0
      ? 0
      : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq))
  return { distanceM: Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)), t }
}

/** True when P lies within `toleranceM` of some segment of the line (flat plane). A line of fewer than two points is near nothing. */
export function nearLine(p: XY, line: readonly XY[], toleranceM: number): boolean {
  for (let i = 1; i < line.length; i++) {
    if (pointToSegment(p, line[i - 1]!, line[i]!).distanceM <= toleranceM) return true
  }
  return false
}

/**
 * Meters along `line` (as alongRouteM counts them) of the line's point closest
 * to `p`. The first of equally close points wins. 0 for a line of fewer than two points.
 */
export function nearestAlongM(line: readonly LngLat[], p: LngLat): number {
  const project = localProjector(p)
  const along = alongRouteM(line)
  let best = { distanceM: Infinity, atM: 0 }
  for (let i = 1; i < line.length; i++) {
    const hit = pointToSegment([0, 0], project(line[i - 1]!), project(line[i]!))
    if (hit.distanceM < best.distanceM) best = { distanceM: hit.distanceM, atM: along[i - 1]! + hit.t * (along[i]! - along[i - 1]!) }
  }
  return best.atM
}

/** True when every point lies inside the box (edges included). */
export function allWithin(points: readonly LngLat[], [west, south, east, north]: BBox): boolean {
  return points.every(([lng, lat]) => lng >= west && lng <= east && lat >= south && lat <= north)
}

/** Compass heading of the straight line from A to B: degrees clockwise from true north, 0 to 360. */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLng = toRad(b[0] - a[0])
  const y = Math.sin(dLng) * Math.cos(toRad(b[1]))
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(dLng)
  const deg = (Math.atan2(y, x) * 180) / Math.PI
  return (deg + 360) % 360
}

/** A place on a polyline: the point itself, which segment it is on, and the heading of that segment. */
export interface PointOnLine {
  readonly point: LngLat
  /** Index of the vertex at or before the point: the point lies on the segment from it to the next vertex. */
  readonly index: number
  /** Heading of travel there, degrees clockwise from true north (0 when the line has no length). */
  readonly bearingDeg: number
}

/**
 * The point `alongM` meters from the start of a polyline (the same meters as
 * alongRouteM). A distance below 0 gives the start and one past the end gives
 * the end. Null when the line has no point. The point is interpolated
 * straight between two vertices, exact enough between the vertices of a road.
 */
export function pointAtDistance(line: readonly LngLat[], alongM: number): PointOnLine | null {
  const first = line[0]
  if (first === undefined) return null
  const along = alongRouteM(line)
  const target = Math.min(Math.max(Number.isFinite(alongM) ? alongM : 0, 0), along.at(-1)!)
  // The first segment with a length that reaches the target.
  let index = 0
  for (let i = 0; i < line.length - 1; i++) {
    if (along[i + 1]! >= target && along[i + 1]! > along[i]!) {
      index = i
      break
    }
  }
  const a = line[index]!
  const b = line[index + 1]
  if (b === undefined) return { point: a, index, bearingDeg: 0 }
  const length = along[index + 1]! - along[index]!
  const t = length > 0 ? Math.min(1, Math.max(0, (target - along[index]!) / length)) : 0
  return {
    point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    index,
    bearingDeg: length > 0 ? bearingDeg(a, b) : 0,
  }
}

/**
 * The rest of a polyline from `alongM` meters after its start: the point
 * there (see pointAtDistance), then every later vertex. Always at least one
 * point for a line that has one; an empty line gives an empty line.
 */
export function lineFrom(line: readonly LngLat[], alongM: number): LngLat[] {
  const at = pointAtDistance(line, alongM)
  if (at === null) return []
  const rest = line.slice(at.index + 1)
  const next = rest[0]
  // Standing exactly on a vertex: do not list it twice.
  return next !== undefined && next[0] === at.point[0] && next[1] === at.point[1] ? rest : [at.point, ...rest]
}
