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
  type LngLat,
  type RouteCandidate,
} from '../src/core/index.ts'
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
