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

const M_PER_DEGREE = (EARTH_RADIUS_M * Math.PI) / 180

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

/** True when every point lies inside the box (edges included). */
export function allWithin(points: readonly LngLat[], [west, south, east, north]: BBox): boolean {
  return points.every(([lng, lat]) => lng >= west && lng <= east && lat >= south && lat <= north)
}
