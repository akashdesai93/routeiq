import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROBE_BUDGET,
  coversRoute,
  DEFAULT_PROBE_OPTIONS,
  mergeProbeRoutes,
  planProbes,
  rankRoutes,
  recommendedRouteId,
  selectViaPoints,
  sideStreetNotice,
  alongRouteM,
  boundsOf,
  distanceM,
  isValidLngLat,
  localProjector,
  pointToSegment,
  SAME_ROUTE_TOLERANCE_M,
  sameRouteGeometry,
  type LngLat,
  type MatchMeter,
  type RouteCandidate,
  type XY,
} from '../src/core/index.ts'
import { everyPointNear } from '../src/core/select.ts'
import { at, candidate, type RouteName } from './helpers/driveWorld.ts'

// Side-street probing, PLAN step 11b: how many probes a plan may make, and how
// probed routes join the provider's routes. The network (tests/helpers/driveWorld.ts)
// runs 20 km east: A straight, B 1 km north of it, C 1 km south, D further north still.

function route(name: RouteName, durationSec: number, extra: Partial<RouteCandidate> = {}): RouteCandidate {
  const r = candidate(name, at(0, 0), durationSec, extra)
  if (r === null) throw new Error(`no route ${name}`)
  return r
}

/** Mapbox's three routes: A fastest. */
const PROVIDER = () => [route('A', 1200), route('B', 1300), route('C', 1250)]

/** The same path as `r` drawn again: a new id, a vertex added in every segment, every point moved by under a meter. */
function redrawn(r: RouteCandidate, extra: Partial<RouteCandidate> = {}): RouteCandidate {
  const nudge = ([lng, lat]: LngLat, k: number): LngLat => [lng + (k % 2 === 0 ? 5e-6 : -5e-6), lat + 4e-6]
  const geometry: LngLat[] = []
  r.geometry.forEach((p, i) => {
    const prev = r.geometry[i - 1]
    if (prev !== undefined) geometry.push(nudge([(prev[0] + p[0]) / 2, (prev[1] + p[1]) / 2], i))
    geometry.push(nudge(p, i + 1))
  })
  return { ...r, id: `${r.id}-probe`, geometry, ...extra }
}

describe('DEFAULT_PROBE_BUDGET', () => {
  it('allows two probe requests per plan, sent 800 ms after the main routes settle', () => {
    expect(DEFAULT_PROBE_BUDGET).toEqual({ requestsPerPlan: 2, debounceMs: 800 })
  })
})

describe('planProbes', () => {
  it('spends at most the budget, taking selectViaPoints in its order', () => {
    // A freeway from 8 to 12 km leaves two surface stretches: four points on offer.
    const split = [route('A', 1200, { limitedAccessSpansM: [[8000, 12000]] })]
    const all = selectViaPoints(split, { ...DEFAULT_PROBE_OPTIONS, maxPoints: 10 })
    expect(all).toHaveLength(4)
    expect(planProbes(split)).toEqual(all.slice(0, DEFAULT_PROBE_BUDGET.requestsPerPlan))
    expect(planProbes(split, { ...DEFAULT_PROBE_BUDGET, requestsPerPlan: 1 })).toEqual(all.slice(0, 1))
    expect(planProbes(split, { ...DEFAULT_PROBE_BUDGET, requestsPerPlan: 2.9 })).toHaveLength(2)
  })

  it('never goes past ProbeOptions.maxPoints, whatever the budget', () => {
    const split = [route('A', 1200, { limitedAccessSpansM: [[8000, 12000]] })]
    expect(planProbes(split, { ...DEFAULT_PROBE_BUDGET, requestsPerPlan: 10 })).toHaveLength(DEFAULT_PROBE_OPTIONS.maxPoints)
  })

  it('makes no request when the budget is under one, or not a finite number', () => {
    for (const requestsPerPlan of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planProbes(PROVIDER(), { ...DEFAULT_PROBE_BUDGET, requestsPerPlan })).toEqual([])
    }
  })

  it('makes no request for a freeway-only trip, a short trip or no routes', () => {
    expect(planProbes([route('A', 900, { limitedAccessSpansM: [[0, 20000]] })])).toEqual([])
    // Surface ends at the ramps fall inside the endpoint clearance: still freeway-only.
    expect(planProbes([route('A', 900, { limitedAccessSpansM: [[800, 19200]] })])).toEqual([])
    expect(planProbes([route('A', 1200)], DEFAULT_PROBE_BUDGET, { ...DEFAULT_PROBE_OPTIONS, minTripM: 25_000 })).toEqual([])
    expect(planProbes([])).toEqual([])
  })

  it('is deterministic', () => {
    const provider = PROVIDER()
    expect(planProbes(provider)).toEqual(planProbes([...provider].reverse()))
    expect(planProbes(provider)).toHaveLength(2)
  })
})

describe('mergeProbeRoutes', () => {
  it('adds a new path, tagged probe, after the provider routes, which stay as they came', () => {
    const provider = PROVIDER()
    const d = route('D', 1400)
    const merged = mergeProbeRoutes(provider, [d])
    expect(merged.slice(0, 3)).toEqual(provider)
    expect(merged.slice(0, 3).every((r) => r.source === undefined)).toBe(true)
    expect(merged).toHaveLength(4)
    expect(merged[3]).toEqual({ ...d, source: 'probe' })
  })

  it('drops a probe that snapped back onto a known route, matched by path and not by id', () => {
    const provider = PROVIDER()
    const again = redrawn(provider[0]!)
    expect(again.id).not.toBe(provider[0]!.id)
    expect(mergeProbeRoutes(provider, [again])).toEqual(provider)
    // A faster ETA does not save it: it is still the same roads.
    expect(mergeProbeRoutes(provider, [redrawn(provider[1]!, { durationSec: 100 })])).toEqual(provider)
  })

  it('keeps a path that leaves a known route for only a short loop', () => {
    // E is A with a 300 m loop north near the end: different roads, so a different route.
    const merged = mergeProbeRoutes(PROVIDER(), [route('E', 1260)])
    expect(merged).toHaveLength(4)
    expect(merged[3]!.source).toBe('probe')
  })

  it('keeps only the first of two probes on the same path', () => {
    const d = route('D', 1400)
    const merged = mergeProbeRoutes(PROVIDER(), [d, redrawn(d, { durationSec: 1100 })])
    expect(merged).toHaveLength(4)
    expect(merged[3]!.id).toBe(d.id)
  })

  it('drops a probe with no usable travel time or line', () => {
    const d = route('D', 1400)
    const bad = [
      { ...d, durationSec: Number.NaN },
      { ...d, durationSec: Number.POSITIVE_INFINITY },
      { ...d, geometry: [d.geometry[0]!] },
      { ...d, geometry: [...d.geometry.slice(0, 3), [Number.NaN, 35] as LngLat] },
    ]
    const provider = PROVIDER()
    expect(mergeProbeRoutes(provider, bad)).toEqual(provider)
  })

  it('drops a dead-end spur: the known route with an out-and-back to the via', () => {
    // A as far as 10 km, 500 m north up a dead end and back, then on along A.
    const provider = PROVIDER()
    const a = provider[0]!
    const spur: RouteCandidate = {
      ...a,
      id: 'A-spur',
      durationSec: 1320,
      geometry: [at(0, 0), at(5000, 0), at(10_000, 0), at(10_000, 500), at(10_000, 0), at(15_000, 0), at(20_000, 0)],
    }
    expect(coversRoute(spur.geometry, a.geometry)).toBe(true)
    expect(mergeProbeRoutes(provider, [spur])).toEqual(provider)
  })

  it('keeps a cut-through that leaves a known route along a segment with no vertices of its own', () => {
    // The known route is one straight segment, start to end: its two vertices are both on E's line.
    const straight: RouteCandidate = { ...route('A', 1200), geometry: [at(0, 0), at(20_000, 0)] }
    const e = route('E', 1260)
    // Sampled every 10 m, A's stretch under E's loop (18.5 to 19.5 km) is not on E.
    expect(coversRoute(e.geometry, straight.geometry)).toBe(false)
    // Its vertices alone would have taken E for "A plus a detour".
    expect(coversRoute(e.geometry, straight.geometry, 10, 0)).toBe(true)
    const merged = mergeProbeRoutes([straight], [e])
    expect(merged).toHaveLength(2)
    expect(merged[1]!.source).toBe('probe')
  })

  it('samples every 10 m (DEFAULT_PROBE_OPTIONS.coverSampleM) and snaps the via within 250 m (viaRadiusM)', () => {
    expect(DEFAULT_PROBE_OPTIONS.coverSampleM).toBe(10)
    expect(DEFAULT_PROBE_OPTIONS.viaRadiusM).toBe(250)
    // No farther than clearOfRoutesM: a via can never snap back onto a known route.
    expect(DEFAULT_PROBE_OPTIONS.viaRadiusM).toBeLessThanOrEqual(DEFAULT_PROBE_OPTIONS.clearOfRoutesM)
  })

  it('with no probes is the provider routes', () => {
    const provider = PROVIDER()
    expect(mergeProbeRoutes(provider, [])).toEqual(provider)
    expect(mergeProbeRoutes([], [route('D', 1400)])).toHaveLength(1)
  })
})

describe('probed routes are ranked by the same ETA-first rules', () => {
  it('a probed route that is faster wins', () => {
    const merged = mergeProbeRoutes(PROVIDER(), [route('D', 1100)])
    const ranked = rankRoutes(merged)
    expect(ranked[0]!.route.source).toBe('probe')
    expect(ranked[0]!.reasons).toEqual(['Fastest right now'])
    expect(recommendedRouteId(merged)).toBe(merged[3]!.id)
  })

  it('a probed route that is slower is not recommended, and says by how much', () => {
    const merged = mergeProbeRoutes(PROVIDER(), [route('D', 1400)])
    const ranked = rankRoutes(merged)
    expect(ranked[0]!.route.source).toBeUndefined()
    expect(ranked.at(-1)!.route.source).toBe('probe')
    expect(ranked.at(-1)!.reasons).toEqual(['3 min slower than the fastest'])
  })

  it('within 30 s, fewer known signals decide, for a probe as for any route; outside it, signals never do', () => {
    const counted = (r: RouteCandidate, n: number): RouteCandidate => ({ ...r, signalCount: n, signalCoverage: 'full' })
    const provider = PROVIDER().map((r) => counted(r, 12))
    const tied = mergeProbeRoutes(provider, [counted(route('D', 1230), 4)])
    expect(rankRoutes(tied)[0]!.route.source).toBe('probe')
    const behind = mergeProbeRoutes(provider, [counted(route('D', 1231), 0)])
    expect(rankRoutes(behind)[0]!.route.source).toBeUndefined()
  })
})

describe('sideStreetNotice (the polite announcement when a probe takes the top spot)', () => {
  const notice = (probe: RouteCandidate, provider: RouteCandidate[] = PROVIDER()) =>
    sideStreetNotice(rankRoutes(mergeProbeRoutes(provider, [probe])))

  it('says how much a recommended side street saves against the best provider route, in whole minutes', () => {
    // Against A at 1200 s: 120 s is 2 min, 100 s rounds to 2, 80 s to 1.
    expect(notice(route('D', 1080))).toBe('Faster route found via side streets, saves 2 min.')
    expect(notice(route('D', 1100))).toBe('Faster route found via side streets, saves 2 min.')
    expect(notice(route('D', 1120))).toBe('Faster route found via side streets, saves 1 min.')
  })

  it('says under a minute for a small saving, and never calls a tie-break win faster', () => {
    expect(notice(route('D', 1180))).toBe('Faster route found via side streets, saves under a minute.')
    const counted = (r: RouteCandidate, n: number): RouteCandidate => ({ ...r, signalCount: n, signalCoverage: 'full' })
    const tied = rankRoutes(mergeProbeRoutes(PROVIDER().map((r) => counted(r, 12)), [counted(route('D', 1220), 4)]))
    expect(tied[0]!.route.source).toBe('probe')
    expect(sideStreetNotice(tied)).toBe('Route via side streets recommended: about the same time, fewer signals.')
  })

  it('claims no fewer signals for a probe that leads on distance while its count is unknown', () => {
    // Same ETA as A, shorter, signals not counted yet: first on distance, but nothing is known about its signals.
    const a = PROVIDER()[0]!
    const shorter = { ...route('D', 1200), distanceM: a.distanceM - 500 }
    const ranked = rankRoutes(mergeProbeRoutes(PROVIDER(), [shorter]))
    expect(ranked[0]!.route.source).toBe('probe')
    expect(sideStreetNotice(ranked)).toBe('Route via side streets recommended: about the same time.')
  })

  it('says nothing when the top route is the provider’s own, or there is none to compare with', () => {
    expect(notice(route('D', 1400))).toBeNull()
    expect(sideStreetNotice(rankRoutes(PROVIDER()))).toBeNull()
    expect(sideStreetNotice([])).toBeNull()
    expect(notice(route('D', 1400), [])).toBeNull()
  })
})

// #93: comparing a probed route with the known ones measured every vertex of one line against
// every segment of the other, so a 60 km plan froze for half a second. The comparison now walks
// along the line and looks further only on a miss (everyPointNear in select.ts). These tests say
// that the answers are those of the old point-by-point comparison, kept here as the reference,
// and that the work (segment distance checks plus grid entries, see MatchMeter) stays linear.
describe('comparing long routes (#93)', () => {
  type Corner = readonly [xM: number, yM: number]

  /** The comparison before #93, verbatim: every point against every segment. */
  const nearAll = (points: readonly XY[], line: readonly XY[], toleranceM: number) =>
    points.every((p) => {
      for (let i = 1; i < line.length; i++) if (pointToSegment(p, line[i - 1]!, line[i]!).distanceM <= toleranceM) return true
      return false
    })
  function oldSameRoute(a: readonly LngLat[], b: readonly LngLat[], toleranceM: number): boolean {
    const lineA = a.filter(isValidLngLat)
    const lineB = b.filter(isValidLngLat)
    if (lineA.length < 2 || lineB.length < 2) return false
    const [west, south, east, north] = boundsOf(lineA)
    const project = localProjector([(west + east) / 2, (south + north) / 2])
    const xyA = lineA.map(project)
    const xyB = lineB.map(project)
    const apart = (p: XY, q: XY) => Math.hypot(p[0] - q[0], p[1] - q[1])
    if (apart(xyA[0]!, xyB[0]!) > toleranceM || apart(xyA.at(-1)!, xyB.at(-1)!) > toleranceM) return false
    return nearAll(xyA, xyB, toleranceM) && nearAll(xyB, xyA, toleranceM)
  }
  function oldCovers(probe: readonly LngLat[], known: readonly LngLat[], toleranceM: number, sampleM: number): boolean {
    if (probe.length < 2 || known.length < 2) return false
    const project = localProjector(known[0]!)
    const samples: LngLat[] = []
    for (let i = 0; i < known.length; i++) {
      const prev = known[i - 1]
      const p = known[i]!
      if (prev !== undefined && Number.isFinite(sampleM) && sampleM > 0) {
        const pieces = Math.ceil(distanceM(prev, p) / sampleM)
        for (let k = 1; k < pieces; k++) samples.push([prev[0] + ((p[0] - prev[0]) * k) / pieces, prev[1] + ((p[1] - prev[1]) * k) / pieces])
      }
      samples.push(p)
    }
    return nearAll(samples.map(project), probe.map(project), toleranceM)
  }

  /** A seeded random number from 0 to 1 (the same every run). */
  const rng = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  const lngLat = (xy: readonly Corner[]) => xy.map(([x, y]) => at(x, y))

  /** A winding road from the origin, `n` vertices 5 to 60 m apart. */
  function road(random: () => number, n: number): Corner[] {
    const out: Corner[] = [[0, 0]]
    let heading = random() * 2 * Math.PI
    for (let i = 1; i < n; i++) {
      heading += (random() - 0.5) * 1.2
      const step = 5 + random() * 55
      const [x, y] = out[i - 1]!
      out.push([x + Math.cos(heading) * step, y + Math.sin(heading) * step])
    }
    return out
  }
  /** Ways the same road, or nearly the same, comes back, some of them within a meter or two of the tolerance. */
  function variants(random: () => number, base: readonly Corner[]): Corner[][] {
    const jitter = (m: number) => base.map(([x, y]): Corner => [x + (random() - 0.5) * m, y + (random() - 0.5) * m])
    const shifted = (m: number) => base.map(([x, y]): Corner => [x + m, y])
    const densified: Corner[] = base.flatMap((p, i) => {
      const q = base[i + 1]
      return q === undefined ? [p] : [p, [(p[0] + q[0]) / 2 + (random() - 0.5), (p[1] + q[1]) / 2 + (random() - 0.5)] as Corner]
    })
    const from = Math.floor(base.length / 3)
    const to = Math.floor((2 * base.length) / 3)
    const detour = (m: number) => base.map(([x, y], i): Corner => (i >= from && i <= to ? [x, y + m] : [x, y]))
    const spur: Corner[] = [...base.slice(0, to), ...[1, 2, 3, 4, 3, 2, 1].map((k): Corner => [base[to]![0] + k * 40, base[to]![1] + k * 40]), ...base.slice(to)]
    return [
      [...base],
      jitter(2),
      jitter(19),
      shifted(9.5),
      shifted(10.5),
      densified,
      base.filter((_, i) => i % 3 !== 1 || i === base.length - 1),
      detour(8),
      detour(14),
      detour(200),
      spur,
      [...base].reverse(),
      base.slice(0, to),
      road(random, base.length),
    ]
  }

  it('gives the same answers as the point-by-point comparison', () => {
    const random = rng(93)
    let compared = 0
    let same = 0
    let covered = 0
    for (let round = 0; round < 6; round++) {
      const base = road(random, 40 + Math.floor(random() * 120))
      const lines = variants(random, base).map(lngLat)
      for (const a of lines) {
        for (const b of lines) {
          for (const toleranceM of [5, SAME_ROUTE_TOLERANCE_M, 30]) {
            const wasSame = oldSameRoute(a, b, toleranceM)
            expect(sameRouteGeometry(a, b, toleranceM)).toBe(wasSame)
            if (wasSame) same++
            for (const sampleM of [0, DEFAULT_PROBE_OPTIONS.coverSampleM]) {
              const wasCovered = oldCovers(a, b, toleranceM, sampleM)
              expect(coversRoute(a, b, toleranceM, sampleM)).toBe(wasCovered)
              if (wasCovered) covered++
            }
            compared++
          }
        }
      }
    }
    // Both answers come up often enough for the comparison to mean something.
    expect(compared).toBe(6 * 14 * 14 * 3)
    expect(same).toBeGreaterThan(compared / 10)
    expect(same).toBeLessThan(compared / 2)
    expect(covered).toBeGreaterThan(compared / 5)
    expect(covered).toBeLessThan(compared)
  })

  // A 100 km plan, 5000 vertices a route: three routes from the provider, two probes that
  // came back on two of them (the common case, and the slowest before #93) and one new side street.
  const random = rng(7)
  const lineA = road(random, 5000)
  const lineB = lineA.map(([x, y], i): Corner => (i > 1500 && i < 3500 ? [x, y + 1000] : [x, y]))
  const lineC = lineA.map(([x, y], i): Corner => (i > 1000 && i < 4000 ? [x, y - 800] : [x, y]))
  const lineS = lineA.map(([x, y], i): Corner => (i > 2000 && i < 2400 ? [x, y - 300] : [x, y]))
  const asRoute = (id: string, xy: readonly Corner[], durationSec: number): RouteCandidate => {
    const geometry = lngLat(xy)
    return { ...route('A', durationSec), id, geometry, distanceM: alongRouteM(geometry).at(-1)!, maneuvers: [] }
  }
  const known = [asRoute('a', lineA, 5000), asRoute('b', lineB, 5100), asRoute('c', lineC, 5200)]
  const backOnKnown = [asRoute('probe-b', lineB.map(([x, y]) => [x + 2, y - 1]), 5150), asRoute('probe-c', lineC.map(([x, y]) => [x - 1, y + 2]), 5250)]
  const sideStreet = asRoute('probe-s', lineS, 4900)
  const vertices = 6 * 5000

  it('a 100 km plan: linear work, at most 10 checks a vertex (about 5.6 now)', () => {
    const meter: MatchMeter = { segmentChecks: 0, gridEntries: 0 }
    const merged = mergeProbeRoutes(known, [...backOnKnown, sideStreet], SAME_ROUTE_TOLERANCE_M, DEFAULT_PROBE_OPTIONS.coverSampleM, meter)
    expect(merged.map((r) => r.id)).toEqual(['a', 'b', 'c', 'probe-s'])
    // The comparison before #93 measured every vertex against every segment: millions here.
    expect(meter.segmentChecks + meter.gridEntries).toBeLessThanOrEqual(10 * vertices)
  })

  it('a probe drawn the other way: still linear', () => {
    const meter: MatchMeter = { segmentChecks: 0, gridEntries: 0 }
    const reversed = [...known[0]!.geometry].reverse()
    expect(coversRoute(reversed, known[0]!.geometry, SAME_ROUTE_TOLERANCE_M, DEFAULT_PROBE_OPTIONS.coverSampleM, meter)).toBe(true)
    expect(meter.segmentChecks + meter.gridEntries).toBeLessThanOrEqual(25 * 5000)
  })

  it('points in no order along the line: the grid takes over, still linear', () => {
    const meter: MatchMeter = { segmentChecks: 0, gridEntries: 0 }
    const shuffled = [...lineA]
    const pick = rng(11)
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(pick() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    expect(everyPointNear(shuffled, lineA, SAME_ROUTE_TOLERANCE_M, meter)).toBe(true)
    expect(everyPointNear([...shuffled, [0, 500]], lineA, SAME_ROUTE_TOLERANCE_M)).toBe(false)
    expect(meter.gridEntries).toBeGreaterThan(0)
    expect(meter.segmentChecks + meter.gridEntries).toBeLessThanOrEqual(30 * 5000)
  })

  it('counting changes nothing: the same answer with or without a meter', () => {
    expect(mergeProbeRoutes(known, [...backOnKnown, sideStreet]).map((r) => r.id)).toEqual(['a', 'b', 'c', 'probe-s'])
  })
})
