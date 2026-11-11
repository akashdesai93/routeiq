import { boundsOf, isValidLngLat, localProjector, pointToSegment, type XY } from './geo.ts'
import { recommendedRouteId, type RankOptions } from './rank.ts'
import type { LngLat, RouteCandidate } from './types.ts'

/**
 * How far apart two polylines may run and still be the same route. Mapbox was
 * seen returning the same roads minutes apart with a few vertices added and
 * points moved by under a meter, which changes the geometry hash; the next
 * street over is tens of meters away.
 */
export const SAME_ROUTE_TOLERANCE_M = 10

function everyPointNear(points: readonly XY[], line: readonly XY[], toleranceM: number): boolean {
  return points.every((p) => {
    for (let i = 1; i < line.length; i++) {
      if (pointToSegment(p, line[i - 1]!, line[i]!).distanceM <= toleranceM) return true
    }
    return false
  })
}

/**
 * True when two polylines follow the same path the same way: they start and
 * end within `toleranceM` of each other, and every vertex of each lies within
 * `toleranceM` of the other line. Works on a flat local plane, like the signal
 * matching.
 */
export function sameRouteGeometry(
  a: readonly LngLat[],
  b: readonly LngLat[],
  toleranceM: number = SAME_ROUTE_TOLERANCE_M,
): boolean {
  const lineA = a.filter(isValidLngLat)
  const lineB = b.filter(isValidLngLat)
  if (lineA.length < 2 || lineB.length < 2) return false
  const [west, south, east, north] = boundsOf(lineA)
  const project = localProjector([(west + east) / 2, (south + north) / 2])
  const xyA = lineA.map(project)
  const xyB = lineB.map(project)
  const apart = (p: XY, q: XY) => Math.hypot(p[0] - q[0], p[1] - q[1])
  if (apart(xyA[0]!, xyB[0]!) > toleranceM || apart(xyA.at(-1)!, xyB.at(-1)!) > toleranceM) return false
  return everyPointNear(xyA, xyB, toleranceM) && everyPointNear(xyB, xyA, toleranceM)
}

/**
 * Which route is selected. A route the user picked stays selected for as long
 * as it keeps coming back: matched by id first (ids come from the geometry),
 * then by path, because a refetch can return the same roads with slightly
 * different points. When the pick is gone, or there is none, the top-ranked
 * route is selected (see rankRoutes in rank.ts). Null when there are no routes.
 */
export function resolveSelectedId(
  routes: readonly RouteCandidate[],
  picked: Pick<RouteCandidate, 'id' | 'geometry'> | null,
  rankOptions: RankOptions = {},
): string | null {
  if (picked !== null) {
    if (routes.some((r) => r.id === picked.id)) return picked.id
    const same = routes.find((r) => sameRouteGeometry(r.geometry, picked.geometry))
    if (same) return same.id
  }
  return recommendedRouteId(routes, rankOptions)
}
