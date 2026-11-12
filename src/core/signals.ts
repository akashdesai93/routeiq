import { boundsOf, distanceM, isValidLngLat, lngDegreesFor, localProjector, M_PER_DEGREE, pointToSegment, type XY } from './geo.ts'
import { tileIdAt, tilesForRoute } from './tiles.ts'
import type {
  DistanceSpanM,
  LngLat,
  RouteCandidate,
  RouteSignal,
  SignalCoverage,
  SignalPoint,
  SignalSource,
} from './types.ts'

/**
 * The distances the signal count is built on. The first three are the rules,
 * applied in this order:
 *   (a) signal points within clusterRadiusM of each other are one intersection;
 *   (b) an intersection counts when it lies within toleranceM of the route line;
 *   (c) and only when the route itself has an intersection within
 *       intersectionRadiusM of it.
 */
export interface SignalMatchOptions {
  /**
   * (a) Signal points this close to each other, directly or through a chain
   * of points each this close to the next, are one intersection.
   * OpenStreetMap tags every approach of a big junction as its own signal, a
   * few tens of meters apart, so without this one junction would count
   * several times. It must stay below the distance between the signals of
   * two neighboring intersections.
   */
  readonly clusterRadiusM: number
  /**
   * (b) An intersection is on the route when one of its signal points, or
   * their middle, lies within this many meters of the route line. The route
   * line follows one carriageway and the signal can sit across a wide divided
   * road or a little before the stop line, so this has to cover that, but
   * stay well short of a parallel street.
   */
  readonly toleranceM: number
  /**
   * (c) An on-route intersection counts only when the route has an
   * intersection of its own (as the directions provider lists them) within
   * this many meters of one of its signal points or their middle. A road
   * that crosses over or under the route does not meet it, so the route has
   * no intersection there and the signals on that road are left out. Routes
   * without an intersection list skip this rule.
   */
  readonly intersectionRadiusM: number
  /**
   * The safety net after the rules above: counted intersections whose
   * positions along the route are within this many meters of each other are
   * one stop and count once.
   */
  readonly mergeRadiusM: number
  /**
   * How far inside a limited-access span (see RouteContext) a signal must be
   * before it is ignored. Within this many meters of either end of a span it
   * still counts, because a freeway or ramp can begin or end AT a signal: the
   * light at the foot of an off-ramp, or where a freeway turns into a street.
   * It has to cover the tolerance above (a signal that far to the side can
   * land that far before the end of the span) plus the few meters by which
   * the two ways of measuring distance along the route differ.
   */
  readonly limitedAccessMarginM: number
}

/** The one place the matching distances are set. */
export const DEFAULT_SIGNAL_MATCH: SignalMatchOptions = {
  clusterRadiusM: 60,
  toleranceM: 30,
  intersectionRadiusM: 40,
  mergeRadiusM: 40,
  limitedAccessMarginM: 30,
}

/** What the directions provider says about the road the route is on. All optional. */
export interface RouteContext {
  /**
   * Where the route's own intersections are, for rule (c). Null, missing or
   * empty means the provider listed none, and the rule is skipped.
   */
  readonly intersections?: readonly LngLat[] | null
  /**
   * Stretches driven on controlled-access road, as [startM, endM] along the
   * route (see RouteCandidate.limitedAccessSpansM). A pass placed inside one,
   * more than limitedAccessMarginM from both of its ends, is dropped: there
   * is no signal to stop at on a freeway. Rule (c) removes most of these
   * already, but not a signal point that sits on the freeway line itself
   * right where a ramp joins it, which is how some signal data marks an
   * interchange. Null, missing or empty changes nothing.
   */
  readonly limitedAccessSpansM?: readonly DistanceSpanM[] | null
}

/** Several signal points that are one intersection (rule a). */
export interface SignalCluster {
  /** The smallest id among its points, so it does not depend on input order. */
  readonly id: string
  /** The middle of its points. */
  readonly position: LngLat
  /** The first name found among its points, in id order. */
  readonly name: string | null
  /** The most trusted source among its points. */
  readonly source: SignalSource
  /** Sorted. */
  readonly memberIds: readonly string[]
  readonly members: readonly LngLat[]
}

export interface RouteSignals {
  /** Distinct signalized intersections in driving order, one entry per pass. */
  readonly signals: readonly RouteSignal[]
  readonly count: number
}

const NONE: RouteSignals = { signals: [], count: 0 }

/** Side of a lookup grid cell for the route matching, in meters. Only affects speed. */
const CELL_M = 250

function nonNegative(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0
}

function resolve(options: Partial<SignalMatchOptions>): SignalMatchOptions {
  const pick = (key: keyof SignalMatchOptions) => nonNegative(options[key] ?? DEFAULT_SIGNAL_MATCH[key])
  return {
    clusterRadiusM: pick('clusterRadiusM'),
    toleranceM: pick('toleranceM'),
    intersectionRadiusM: pick('intersectionRadiusM'),
    mergeRadiusM: pick('mergeRadiusM'),
    limitedAccessMarginM: pick('limitedAccessMarginM'),
  }
}

/**
 * Finds the points within `radiusM` of a point without comparing every pair:
 * points are bucketed into a grid of cells at least `radiusM` wide, so only
 * the nine cells around a point need looking at. Distances are great-circle,
 * so it works for points spread over any area (not across the antimeridian).
 */
function pointGrid<T>(radiusM: number, points: readonly LngLat[]) {
  let widestLat = 0
  for (const [, lat] of points) widestLat = Math.max(widestLat, Math.abs(lat))
  // A little over the radius, so rounding at a cell edge cannot hide a neighbor.
  const cellLat = Math.max((radiusM * 1.01) / M_PER_DEGREE, 1e-9)
  const cellLng = lngDegreesFor(cellLat, widestLat)
  const cells = new Map<string, { at: LngLat; value: T }[]>()
  const cellOf = ([lng, lat]: LngLat): [number, number] => [Math.floor(lng / cellLng), Math.floor(lat / cellLat)]
  return {
    add(at: LngLat, value: T) {
      const [cx, cy] = cellOf(at)
      const key = `${cx}:${cy}`
      const cell = cells.get(key)
      if (cell) cell.push({ at, value })
      else cells.set(key, [{ at, value }])
    },
    /** Every stored value within radiusM of `at` (the edge included). */
    within(at: LngLat): T[] {
      const [cx, cy] = cellOf(at)
      const found: T[] = []
      for (let x = cx - 1; x <= cx + 1; x++) {
        for (let y = cy - 1; y <= cy + 1; y++) {
          for (const entry of cells.get(`${x}:${y}`) ?? []) {
            if (distanceM(at, entry.at) <= radiusM) found.push(entry.value)
          }
        }
      }
      return found
    },
  }
}

interface Sourced {
  readonly point: SignalPoint
  readonly source: SignalSource
}

const SOURCE_ORDER: readonly SignalSource[] = ['primary', 'fallback']

function clusterSourced(sourced: readonly Sourced[], radiusM: number): SignalCluster[] {
  // One entry per id (a point on a tile edge arrives once per tile), in id order.
  const byId = new Map<string, Sourced>()
  for (const s of sourced) {
    if (isValidLngLat(s.point.position) && !byId.has(s.point.id)) byId.set(s.point.id, s)
  }
  const points = [...byId.values()].sort((a, b) => (a.point.id < b.point.id ? -1 : 1))

  const parent = points.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!
      i = parent[i]!
    }
    return i
  }
  if (radiusM > 0) {
    const grid = pointGrid<number>(
      radiusM,
      points.map((s) => s.point.position),
    )
    points.forEach((s, i) => {
      for (const j of grid.within(s.point.position)) {
        const a = find(i)
        const b = find(j)
        // The smaller index (the smaller id) stays the root.
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
      }
      grid.add(s.point.position, i)
    })
  }

  const groups = new Map<number, Sourced[]>()
  points.forEach((s, i) => {
    const root = find(i)
    const group = groups.get(root)
    if (group) group.push(s)
    else groups.set(root, [s])
  })
  return [...groups.values()].map((group) => {
    const members = group.map((s) => s.point.position)
    return {
      id: group[0]!.point.id,
      position: [
        members.reduce((sum, p) => sum + p[0], 0) / members.length,
        members.reduce((sum, p) => sum + p[1], 0) / members.length,
      ],
      name: group.find((s) => s.point.name !== null)?.point.name ?? null,
      source: SOURCE_ORDER.find((source) => group.some((s) => s.source === source))!,
      memberIds: group.map((s) => s.point.id),
      members,
    }
  })
}

/**
 * Rule (a): groups signal points into intersections. Two points are in the
 * same group when they are within `radiusM` of each other, or joined by a
 * chain of points each within `radiusM` of the next. A point given twice
 * (same id) is used once. Pure, and the result does not depend on the order
 * of the input; groups come back in id order. A radius of 0 groups nothing.
 */
export function clusterSignals(
  points: readonly SignalPoint[],
  radiusM: number = DEFAULT_SIGNAL_MATCH.clusterRadiusM,
): SignalCluster[] {
  return clusterSourced(
    points.map((point) => ({ point, source: 'primary' })),
    nonNegative(radiusM),
  )
}

interface Hit {
  readonly atDistanceM: number
  readonly offsetM: number
}

interface Pass extends Hit {
  readonly cluster: SignalCluster
}

/** Rules (b) and (c), the freeway spans, then the along-route merge, for intersections already grouped. */
function clustersOnRoute(
  geometry: readonly LngLat[],
  clusters: readonly SignalCluster[],
  options: SignalMatchOptions,
  context: RouteContext,
): RouteSignals {
  const { toleranceM, mergeRadiusM, intersectionRadiusM, limitedAccessMarginM: marginM } = options
  const spans = context.limitedAccessSpansM ?? []
  const onLimitedAccess = (atDistanceM: number) =>
    spans.some(([startM, endM]) => atDistanceM >= startM + marginM && atDistanceM <= endM - marginM)
  const line = geometry.filter(isValidLngLat)
  if (line.length < 2 || clusters.length === 0) return NONE

  const [west, south, east, north] = boundsOf(line)
  const project = localProjector([(west + east) / 2, (south + north) / 2])
  const [minX, minY] = project([west, south])
  const [maxX, maxY] = project([east, north])

  // Each intersection is tested at every one of its signal points and at their middle.
  // Only those inside the route's bounding box (plus the tolerance) can match.
  const probes: { cluster: number; xy: XY }[] = []
  const probesOf = new Map<number, XY[]>()
  clusters.forEach((cluster, n) => {
    const all = [cluster.position, ...cluster.members].map(project)
    let any = false
    for (const xy of all) {
      if (xy[0] < minX - toleranceM || xy[0] > maxX + toleranceM) continue
      if (xy[1] < minY - toleranceM || xy[1] > maxY + toleranceM) continue
      probes.push({ cluster: n, xy })
      any = true
    }
    if (any) probesOf.set(n, all)
  })
  if (probes.length === 0) return NONE

  // Bucket the probes into a grid so each segment only looks at the ones around it.
  let gridMinX = Infinity
  let gridMinY = Infinity
  let gridMaxX = -Infinity
  let gridMaxY = -Infinity
  for (const { xy } of probes) {
    gridMinX = Math.min(gridMinX, xy[0])
    gridMaxX = Math.max(gridMaxX, xy[0])
    gridMinY = Math.min(gridMinY, xy[1])
    gridMaxY = Math.max(gridMaxY, xy[1])
  }
  const col = (x: number) => Math.floor((x - gridMinX) / CELL_M)
  const row = (y: number) => Math.floor((y - gridMinY) / CELL_M)
  const lastCol = col(gridMaxX)
  const lastRow = row(gridMaxY)
  const cells = new Map<number, number[]>()
  probes.forEach(({ xy }, n) => {
    const key = row(xy[1]) * (lastCol + 1) + col(xy[0])
    const cell = cells.get(key)
    if (cell) cell.push(n)
    else cells.set(key, [n])
  })

  // Rule (b): every place the line comes within tolerance of a probe, per intersection.
  const hits = new Map<number, Hit[]>()
  let a = project(line[0]!)
  let travelledM = 0
  for (let i = 1; i < line.length; i++) {
    const b = project(line[i]!)
    const lengthM = Math.hypot(b[0] - a[0], b[1] - a[1])
    const col0 = Math.max(0, col(Math.min(a[0], b[0]) - toleranceM))
    const col1 = Math.min(lastCol, col(Math.max(a[0], b[0]) + toleranceM))
    const row0 = Math.max(0, row(Math.min(a[1], b[1]) - toleranceM))
    const row1 = Math.min(lastRow, row(Math.max(a[1], b[1]) + toleranceM))
    for (let r = row0; r <= row1; r++) {
      for (let c = col0; c <= col1; c++) {
        const cell = cells.get(r * (lastCol + 1) + c)
        if (!cell) continue
        for (const n of cell) {
          const probe = probes[n]!
          const { distanceM: offsetM, t } = pointToSegment(probe.xy, a, b)
          if (offsetM > toleranceM) continue
          const hit = { atDistanceM: travelledM + t * lengthM, offsetM }
          const list = hits.get(probe.cluster)
          if (list) list.push(hit)
          else hits.set(probe.cluster, [hit])
        }
      }
    }
    travelledM += lengthM
    a = b
  }

  // Rule (c): the route must have an intersection of its own at the signal.
  const crossings = (context.intersections ?? []).filter(isValidLngLat).map(project)
  const atRouteIntersection = (n: number) =>
    crossings.length === 0 ||
    probesOf
      .get(n)!
      .some((p) => crossings.some((x) => Math.hypot(p[0] - x[0], p[1] - x[1]) <= intersectionRadiusM))

  // One pass per stretch of route that stays near the intersection, placed at its
  // closest approach. A route that comes back later (a loop) passes it again.
  const passes: Pass[] = []
  for (const [n, clusterHits] of hits) {
    if (!atRouteIntersection(n)) continue
    const cluster = clusters[n]!
    const all = probesOf.get(n)!
    const centre = all[0]!
    const reachM = Math.max(...all.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1])))
    // Hits of one drive through cannot be further apart than the intersection is wide, plus the tolerance at both ends.
    const samePassM = 2 * (reachM + toleranceM) + mergeRadiusM
    clusterHits.sort((p, q) => p.atDistanceM - q.atDistanceM)
    let best: Hit | null = null
    let previousM = 0
    const closePass = () => {
      if (best !== null && !onLimitedAccess(best.atDistanceM)) passes.push({ cluster, ...best })
      best = null
    }
    for (const hit of clusterHits) {
      if (best !== null && hit.atDistanceM - previousM > samePassM) closePass()
      if (best === null || hit.offsetM < best.offsetM) best = hit
      previousM = hit.atDistanceM
    }
    closePass()
  }
  passes.sort(
    (p, q) => p.atDistanceM - q.atDistanceM || p.offsetM - q.offsetM || (p.cluster.id < q.cluster.id ? -1 : 1),
  )

  // Passes of different intersections close together along the route are one stop.
  const merged: RouteSignal[] = []
  let group: Pass[] = []
  const closeGroup = () => {
    if (group.length === 0) return
    const closest = group.reduce((p, q) => (q.offsetM < p.offsetM ? q : p))
    merged.push({
      id: closest.cluster.id,
      position: closest.cluster.position,
      name: closest.cluster.name,
      source: closest.cluster.source,
      atDistanceM: closest.atDistanceM,
      offsetM: closest.offsetM,
      mergedIds: [...new Set(group.flatMap((p) => p.cluster.memberIds))],
    })
    group = []
  }
  for (const pass of passes) {
    if (group.length > 0 && pass.atDistanceM - group[0]!.atDistanceM > mergeRadiusM) closeGroup()
    group.push(pass)
  }
  closeGroup()
  return { signals: merged, count: merged.length }
}

/**
 * Which signalized intersections a route passes through, and how many.
 *
 * (a) The signal points are grouped into intersections (clusterSignals).
 * (b) An intersection is on the route when one of its points, or their
 *     middle, is within `toleranceM` of the route line. This works on a flat
 *     local plane (equirectangular, fine at city scale).
 * (c) With `context.intersections`, it must also have one of the route's own
 *     intersections within `intersectionRadiusM`: that removes signals on
 *     roads passing over or under the route. Without them the rule is skipped.
 *
 * Each stretch of route that stays near an intersection is one pass, placed
 * at its closest approach, so a looping route that crosses the same
 * intersection twice counts it twice. A pass deep inside one of
 * `context.limitedAccessSpansM` is dropped. Passes within `mergeRadiusM` of each
 * other along the route are merged into one. `atDistanceM` is measured along
 * the route on the flat plane, so it can differ from the provider's route
 * distance by a fraction of a percent.
 *
 * Pure. Options left out take their defaults; a distance that is negative or
 * not a number is treated as 0. Invalid coordinates are ignored; fewer than
 * two valid route points or no signals gives a count of 0. It only knows the
 * signals it is given: see withSignalCounts for routes with missing data.
 */
export function signalsOnRoute(
  geometry: readonly LngLat[],
  signals: readonly SignalPoint[],
  options: Partial<SignalMatchOptions> = DEFAULT_SIGNAL_MATCH,
  context: RouteContext = {},
): RouteSignals {
  const resolved = resolve(options)
  return clustersOnRoute(geometry, clusterSignals(signals, resolved.clusterRadiusM), resolved, context)
}

/**
 * The tiles (see tiles.ts) whose signal data a route needs: those it passes
 * through, plus any within reach of the three rule distances, so that an
 * intersection lying across a tile edge is loaded whole.
 */
export function signalTilesForRoute(
  geometry: readonly LngLat[],
  options: Partial<SignalMatchOptions> = DEFAULT_SIGNAL_MATCH,
): string[] {
  const { clusterRadiusM, toleranceM, intersectionRadiusM } = resolve(options)
  return tilesForRoute(geometry, clusterRadiusM + toleranceM + intersectionRadiusM)
}

/**
 * Everything known about signals when routes are counted. The route's own
 * signal flags (the fallback) are added in memory, inside withSignalCounts.
 */
export interface SignalData {
  /** Points of the primary source, from every tile that was loaded. A point may appear more than once. */
  readonly primary: readonly SignalPoint[]
  /** The tiles `primary` is complete for. A tile a route needs that is not listed here is missing data. */
  readonly primaryTileIds: ReadonlySet<string>
}

export interface CountedRoutes {
  /** The same routes, in the same order, with signalCount and signalCoverage filled. */
  readonly routes: readonly RouteCandidate[]
  /** On-route signals by route id, for drawing. */
  readonly signalsByRouteId: ReadonlyMap<string, readonly RouteSignal[]>
}

/**
 * Fills signalCount and signalCoverage on each route.
 *
 * For every route it works out the tiles the route needs (signalTilesForRoute)
 * and takes signals from two places, most trusted first:
 * 1. the primary data, for the tiles that were loaded;
 * 2. the route's own signal-flagged intersections (RouteIntersection.signal),
 *    but only those lying in tiles whose primary data is missing.
 * Both then go through the same rules (signalsOnRoute), with the route's
 * intersections and limited-access spans as context.
 *
 * Coverage is 'full' when every needed tile was loaded: the count is the
 * answer, and may be 0. It is 'partial' when a needed tile is missing: the
 * count is what the two sources found, a rough lower bound. It is 'none',
 * with a null count, when nothing at all is known about the route: no needed
 * tile loaded and no intersection list. `data` null means
 * nothing has been loaded yet and leaves the routes untouched.
 *
 * Pure. Order and every other field are untouched.
 */
export function withSignalCounts(
  routes: readonly RouteCandidate[],
  data: SignalData | null,
  options: Partial<SignalMatchOptions> = DEFAULT_SIGNAL_MATCH,
): CountedRoutes {
  const signalsByRouteId = new Map<string, readonly RouteSignal[]>()
  if (data === null) return { routes, signalsByRouteId }
  const resolved = resolve(options)
  const primary: Sourced[] = data.primary.map((point) => ({ point, source: 'primary' }))

  const counted = routes.map((route): RouteCandidate => {
    const needed = signalTilesForRoute(route.geometry, resolved)
    const missing = needed.filter((id) => !data.primaryTileIds.has(id))
    if (missing.length === needed.length && route.intersections === null) {
      return { ...route, signalCount: null, signalCoverage: 'none' }
    }

    const fallback: Sourced[] = []
    if (missing.length > 0) {
      route.intersections?.forEach((intersection, i) => {
        if (!intersection.signal || !isValidLngLat(intersection.location)) return
        if (data.primaryTileIds.has(tileIdAt(intersection.location))) return
        fallback.push({
          point: { id: `flag-${String(i).padStart(5, '0')}`, position: intersection.location, name: null },
          source: 'fallback',
        })
      })
    }
    const clusters = clusterSourced([...primary, ...fallback], resolved.clusterRadiusM)
    const found = clustersOnRoute(route.geometry, clusters, resolved, {
      intersections: route.intersections?.map((i) => i.location) ?? null,
      limitedAccessSpansM: route.limitedAccessSpansM,
    })
    signalsByRouteId.set(route.id, found.signals)
    const signalCoverage: SignalCoverage = missing.length === 0 ? 'full' : 'partial'
    return { ...route, signalCount: found.count, signalCoverage }
  })
  return { routes: counted, signalsByRouteId }
}
