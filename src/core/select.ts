import { boundsOf, isValidLngLat, localProjector, pointToSegment, segmentGrid, type MatchMeter, type SegmentGrid, type XY } from './geo.ts'
import { recommendedRouteId, type RankOptions } from './rank.ts'
import type { LngLat, RouteCandidate } from './types.ts'

/**
 * How far apart two polylines may run and still be the same route. Mapbox was
 * seen returning the same roads minutes apart with a few vertices added and
 * points moved by under a meter, which changes the geometry hash; the next
 * street over is tens of meters away.
 */
export const SAME_ROUTE_TOLERANCE_M = 10

/**
 * The grid reaches a meter past the tolerance, so that a segment exactly at the
 * tolerance is never missed by rounding at a cell edge. It only decides which
 * segments are measured; the answer is the same distance test as before.
 */
const GRID_MARGIN_M = 1
/** Segments looked at ahead of the last hit (and one behind) before looking further. */
const WALK_AHEAD = 4
/**
 * Misses of the walk answered by measuring the whole line, before a segment
 * grid is built for the rest. Two different routes part at the first point
 * that is off the other line, and one scan costs less than building a grid;
 * a bounded number keeps the worst case linear.
 */
const SCANS_BEFORE_GRID = 8

/**
 * True when every point lies within `toleranceM` of `line` (also coversRoute
 * in probe.ts). Points of a route come in order along it, so each one first
 * tries the few segments after the one the previous point was near. A miss
 * there measures the whole line, for the first few misses, and then asks a
 * segment grid of the line (segmentGrid in geo.ts), built once it is needed. Either way a point counts as near only when one segment
 * really is within the tolerance, so the answer is the same as measuring
 * every segment; the work is linear in the length instead of quadratic.
 */
export function everyPointNear(points: readonly XY[], line: readonly XY[], toleranceM: number, meter?: MatchMeter): boolean {
  const segments = line.length - 1
  if (segments < 1) return points.length === 0
  let grid: SegmentGrid | null = null
  let last = 1
  let scans = 0
  return points.every((p) => {
    const to = Math.min(segments, last + WALK_AHEAD)
    for (let i = Math.max(1, last - 1); i <= to; i++) {
      if (meter !== undefined) meter.segmentChecks++
      if (pointToSegment(p, line[i - 1]!, line[i]!).distanceM <= toleranceM) {
        last = i
        return true
      }
    }
    let hit = 0
    if (scans < SCANS_BEFORE_GRID) {
      scans++
      for (let i = 1; i <= segments && hit === 0; i++) {
        if (meter !== undefined) meter.segmentChecks++
        if (pointToSegment(p, line[i - 1]!, line[i]!).distanceM <= toleranceM) hit = i
      }
    } else {
      grid ??= segmentGrid(line, toleranceM + GRID_MARGIN_M, meter)
      hit = grid.segmentWithin(p, toleranceM)
    }
    if (hit === 0) return false
    last = hit
    return true
  })
}

/**
 * True when two polylines follow the same path the same way: they start and
 * end within `toleranceM` of each other, and every vertex of each lies within
 * `toleranceM` of the other line. Works on a flat local plane, like the signal
 * matching. Each vertex looks only at the segments of the other line near it
 * (segmentGrid in geo.ts), so long routes compare in linear time; `meter`,
 * when given, is counted up with the work done.
 */
export function sameRouteGeometry(
  a: readonly LngLat[],
  b: readonly LngLat[],
  toleranceM: number = SAME_ROUTE_TOLERANCE_M,
  meter?: MatchMeter,
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
  return everyPointNear(xyA, xyB, toleranceM, meter) && everyPointNear(xyB, xyA, toleranceM, meter)
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
