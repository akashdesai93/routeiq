import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  alongRouteM,
  checkProbeAllowance,
  checkProbes,
  type CongestionLevel,
  DEFAULT_DRIVE_PROBE_BUDGET,
  DEFAULT_PROBE_OPTIONS,
  INITIAL_CHECK_PROBES,
  INITIAL_REROUTE_STATE,
  mergeCheckProbes,
  rememberCheckProbes,
  distanceM,
  localProjector,
  pointToSegment,
  selectViaPoints,
  type LngLat,
  type RouteCandidate,
  type ViaPoint,
} from '../src/core/index.ts'
import { parseDirections } from '../src/providers/mapbox/adapter.ts'
import { at, candidate } from './helpers/driveWorld.ts'

function fixtureRoutes(name: string): readonly RouteCandidate[] {
  const result = parseDirections(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')))
  if (!result.ok) throw new Error(`expected routes, got ${result.kind}`)
  return result.routes
}

function world(name: Parameters<typeof candidate>[0], durationSec: number, extra: Partial<RouteCandidate> = {}) {
  const route = candidate(name, at(0, 0), durationSec, extra)
  if (route === null) throw new Error(`no route ${name}`)
  return route
}

function lineDistanceM(point: LngLat, line: readonly LngLat[]): number {
  const project = localProjector(point)
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    best = Math.min(best, pointToSegment(project(point), project(line[i - 1]!), project(line[i]!)).distanceM)
  }
  return best
}

/** The fastest is A (straight east 20 km); B runs 1 km north of it, C 1 km south. */
const WORLD = () => [world('A', 1200), world('B', 1300), world('C', 1250)]

function expectWellPlaced(points: readonly ViaPoint[], candidates: readonly RouteCandidate[]) {
  const o = DEFAULT_PROBE_OPTIONS
  for (const p of points) {
    const base = candidates.find((c) => c.id === p.baseRouteId)!
    for (const c of candidates) expect(lineDistanceM(p.position, c.geometry)).toBeGreaterThanOrEqual(o.clearOfRoutesM)
    expect(distanceM(p.position, base.geometry[0]!)).toBeGreaterThanOrEqual(o.endpointClearanceM)
    expect(distanceM(p.position, base.geometry.at(-1)!)).toBeGreaterThanOrEqual(o.endpointClearanceM)
    expect(o.offsetsM).toContain(p.offsetM)
    // The point sits square to the route, at its offset (to within a few meters of projection error).
    expect(Math.abs(lineDistanceM(p.position, base.geometry) - p.offsetM)).toBeLessThan(5)
    const lengthM = alongRouteM(base.geometry).at(-1)!
    expect(p.targetSpanM[0]).toBeGreaterThanOrEqual(o.endpointClearanceM)
    expect(p.targetSpanM[1]).toBeLessThanOrEqual(lengthM - o.endpointClearanceM)
    expect(p.targetSpanM[1] - p.targetSpanM[0]).toBeGreaterThanOrEqual(o.minStretchM)
    expect(p.reason).not.toBe('')
  }
}

describe('selectViaPoints', () => {
  it('probes both sides of the longest surface stretch of the fastest route', () => {
    const candidates = WORLD()
    const points = selectViaPoints(candidates)
    expect(points).toHaveLength(2)
    expect(points.every((p) => p.baseRouteId === candidates[0]!.id)).toBe(true)
    expect(new Set(points.map((p) => p.side))).toEqual(new Set(['left', 'right']))
    // The middle of the stretch [1 km, 19 km], 500 m north (left) and south (right).
    const left = points.find((p) => p.side === 'left')!
    expect(distanceM(left.position, at(10000, 500))).toBeLessThan(2)
    expect(distanceM(points.find((p) => p.side === 'right')!.position, at(10000, -500))).toBeLessThan(2)
    expect(left.targetSpanM[0]).toBeCloseTo(1000, 0)
    expect(left.reason).toContain('left')
    expectWellPlaced(points, candidates)
  })

  it('takes left and right from the direction of travel', () => {
    // A driven west: left is now south.
    const west = { ...world('A', 1200), id: 'west', geometry: [...world('A', 1200).geometry].reverse() }
    const left = selectViaPoints([west]).find((p) => p.side === 'left')!
    expect(distanceM(left.position, at(10000, -500))).toBeLessThan(2)
    // A diagonal route north-east: left is to the north-west of it.
    const diagonal = { ...world('A', 1200), id: 'diag', geometry: [at(0, 0), at(10000, 10000)] }
    const diagLeft = selectViaPoints([diagonal]).find((p) => p.side === 'left')!
    const d = 500 / Math.SQRT2
    expect(distanceM(diagLeft.position, at(5000 - d, 5000 + d))).toBeLessThan(2)
  })

  it('is deterministic and does not depend on candidate order', () => {
    const candidates = WORLD()
    const once = selectViaPoints(candidates)
    expect(selectViaPoints(candidates)).toEqual(once)
    expect(selectViaPoints([...candidates].reverse())).toEqual(once)
  })

  it('breaks an equal-duration tie by the smaller id, whatever the order', () => {
    // Same ETA: 'a' (A, straight) must be the base over 'b' (D, north detour), in either order.
    const a = { ...world('A', 1200), id: 'a' }
    const b = { ...world('D', 1200), id: 'b' }
    for (const candidates of [[a, b], [b, a]]) {
      const points = selectViaPoints(candidates)
      expect(points.length).toBeGreaterThan(0)
      expect(points.every((p) => p.baseRouteId === 'a')).toBe(true)
    }
  })

  it('orders sides by room even when another candidate has a NaN coordinate', () => {
    // B runs 1 km north of A, so the right (south) side has more room and comes first.
    const candidates = [world('A', 1200), world('B', 1300)]
    expect(selectViaPoints(candidates).map((p) => p.side)).toEqual(['right', 'left'])
    const geometry = [...world('C', 1250).geometry]
    geometry[3] = [Number.NaN, Number.NaN]
    const broken = { ...world('C', 1250), id: 'broken', geometry }
    expect(selectViaPoints([...candidates, broken]).map((p) => p.side)).toEqual(['right', 'left'])
  })

  it('merges overlapping freeway spans and ignores empty, reversed or NaN ones', () => {
    const spansOf = (limitedAccessSpansM: RouteCandidate['limitedAccessSpansM']) =>
      selectViaPoints([world('A', 1200, { limitedAccessSpansM })], { ...DEFAULT_PROBE_OPTIONS, maxPoints: 10 }).map(
        (p) => p.targetSpanM,
      )
    const whole = [
      [1000, 19000],
      [1000, 19000],
    ]
    // [3, 8] and [5, 12] km overlap into one freeway from 3 to 12 km: stretches [12, 19] and [1, 3] km.
    const overlapping = spansOf([
      [5000, 12000],
      [3000, 8000],
    ])
    expect(overlapping.map((s) => s.map((m) => Math.round(m)))).toEqual([
      [12000, 19000],
      [1000, 3000],
      [12000, 19000],
      [1000, 3000],
    ])
    expect(spansOf([[4000, 6000], [4500, 5500]]).map((s) => s.map((m) => Math.round(m)))).toEqual([
      [6000, 19000],
      [1000, 4000],
      [6000, 19000],
      [1000, 4000],
    ])
    expect(spansOf([])).toEqual(spansOf(null))
    for (const spans of [[[5000, 5000]], [[8000, 3000]], [[2000, Number.NaN]], [[Number.NaN, 6000]]] as const) {
      expect(spansOf(spans as unknown as RouteCandidate['limitedAccessSpansM']).map((s) => s.map(Math.round))).toEqual(
        whole,
      )
    }
  })

  it("uses the segment's own heading at a hairpin", () => {
    // East 10 km, north 100 m, back west 10 km. A freeway over the last 1.04 km puts the probe spot
    // on the short northbound link, 30 m up it, where the ±150 m chord is much shorter than the window.
    const hairpin: RouteCandidate = {
      ...world('A', 1200),
      id: 'hairpin',
      geometry: [at(0, 0), at(10000, 0), at(10000, 100), at(0, 100)],
      limitedAccessSpansM: [[19060, 20100]],
    }
    const points = selectViaPoints([hairpin])
    // Heading north: right is east. The chord would tilt it and land on the eastbound leg.
    expect(points.map((p) => [p.side, p.offsetM])).toEqual([['right', 500]])
    expect(distanceM(points[0]!.position, at(10500, 30))).toBeLessThan(2)
  })

  it('spreads a small budget over stretches before taking second sides, and respects maxPoints', () => {
    // A freeway span from 8 to 12 km splits A into two surface stretches: [1, 8] and [12, 19] km.
    const candidates = [world('A', 1200, { limitedAccessSpansM: [[8000, 12000]] })]
    const all = selectViaPoints(candidates, { ...DEFAULT_PROBE_OPTIONS, maxPoints: 10 })
    expect(all).toHaveLength(4)
    const two = selectViaPoints(candidates, { ...DEFAULT_PROBE_OPTIONS, maxPoints: 2 })
    expect(two).toEqual(all.slice(0, 2))
    expect(two[0]!.targetSpanM).not.toEqual(two[1]!.targetSpanM)
    expect(selectViaPoints(candidates, { ...DEFAULT_PROBE_OPTIONS, maxPoints: 1 })).toHaveLength(1)
    expect(selectViaPoints(candidates, { ...DEFAULT_PROBE_OPTIONS, maxPoints: 0 })).toEqual([])
    expect(selectViaPoints(candidates).length).toBeLessThanOrEqual(DEFAULT_PROBE_OPTIONS.maxPoints)
    expectWellPlaced(all, candidates)
  })

  it('returns nothing for a freeway-only trip', () => {
    const freeway = world('A', 900, { limitedAccessSpansM: [[0, 20000]] })
    expect(selectViaPoints([freeway])).toEqual([])
    // Short surface ends at the ramps do not count: they fall inside the endpoint clearance.
    expect(selectViaPoints([world('A', 900, { limitedAccessSpansM: [[600, 19400]] })])).toEqual([])
  })

  it('returns nothing for a tiny trip', () => {
    expect(selectViaPoints(fixtureRoutes('directions.freeway.json'))).toEqual([])
    const short = candidate('A', at(18000, 0), 120)!
    expect(selectViaPoints([short])).toEqual([])
  })

  it('moves out, or drops the point, when an existing route already runs there', () => {
    // An alternative running 500 m north of A along the probe spot pushes the left point out to 800 m.
    const near = { ...world('A', 1300), id: 'near', geometry: [at(0, 0), at(5000, 500), at(15000, 500), at(20000, 0)] }
    const candidates = [world('A', 1200), near]
    const points = selectViaPoints(candidates)
    expect(points.find((p) => p.side === 'left')!.offsetM).toBe(800)
    expectWellPlaced(points, candidates)
    // With a single 500 m offset the left side has nowhere to go.
    const only500 = selectViaPoints(candidates, { ...DEFAULT_PROBE_OPTIONS, offsetsM: [500] })
    expect(only500.map((p) => p.side)).toEqual(['right'])
  })

  it('never places points near the origin or destination', () => {
    // A 3.5 km trip: its only stretch is [1, 2.5] km, so the probe spot is 1.75 km from each end.
    const short = candidate('A', at(16500, 0), 300)!
    const points = selectViaPoints([short])
    expect(points.length).toBeGreaterThan(0)
    expectWellPlaced(points, [short])
    // A clearance bigger than half the trip leaves nothing to probe.
    expect(selectViaPoints([short], { ...DEFAULT_PROBE_OPTIONS, endpointClearanceM: 1800 })).toEqual([])
  })

  it('works on the Mapbox fixtures', () => {
    for (const name of ['directions.ok.json', 'directions.corridor.json']) {
      const candidates = fixtureRoutes(name)
      const points = selectViaPoints(candidates)
      expect(points.length, name).toBeGreaterThan(0)
      expect(points.length, name).toBeLessThanOrEqual(DEFAULT_PROBE_OPTIONS.maxPoints)
      // The fastest route is the base: in directions.ok.json that is the second one (840 s).
      const fastest = [...candidates].sort((a, b) => a.durationSec - b.durationSec)[0]!
      expect(points.every((p) => p.baseRouteId === fastest.id), name).toBe(true)
      expectWellPlaced(points, candidates)
    }
  })

  it('treats unknown road kinds as surface street', () => {
    expect(selectViaPoints([world('A', 1200, { limitedAccessSpansM: null })])).toHaveLength(2)
  })

  it('survives degenerate input', () => {
    expect(selectViaPoints([])).toEqual([])
    const dot = { ...world('A', 10), id: 'dot', geometry: [at(10000, 0)] }
    expect(selectViaPoints([dot])).toEqual([])
    const empty = { ...world('A', 10), id: 'empty', geometry: [] }
    expect(selectViaPoints([empty])).toEqual([])
    const nan = { ...world('A', Number.NaN), id: 'nan' }
    expect(selectViaPoints([nan])).toEqual([])
    // Unusable candidates are never the base, and a single-point one does not break the clearance check.
    const points = selectViaPoints([dot, empty, nan, world('A', 1200)])
    expect(points).toHaveLength(2)
    expect(points.every((p) => p.baseRouteId.startsWith('A-'))).toBe(true)
  })
})

/**
 * A's geometry with per-segment congestion: a segment whose middle lies in one
 * of `jams` (meters along A, which runs straight east) is at `level`, every
 * other one is low.
 */
function jammedA(durationSec: number, jams: readonly (readonly [number, number])[], level: CongestionLevel = 'heavy') {
  const route = world('A', durationSec)
  const along = alongRouteM(route.geometry)
  const congestion = along.slice(1).map((end, i): CongestionLevel => {
    const mid = (along[i]! + end) / 2
    return jams.some(([a, b]) => mid > a && mid < b) ? level : 'low'
  })
  return { ...route, segmentTraffic: { congestion, durationSec: null } }
}

/** The points without the base route's id: the test world numbers its routes as they are made. */
const placed = (points: readonly ViaPoint[]) => points.map((p) => ({ ...p, baseRouteId: '' }))

describe('selectViaPoints with live traffic (segmentTraffic)', () => {
  it('aims at the middle of the jam, not the middle of the stretch', () => {
    // Heavy traffic from 3 to 5 km on A's one surface stretch [1, 19] km.
    const candidates = [jammedA(1200, [[3000, 5000]]), world('B', 1300), world('C', 1250)]
    const points = selectViaPoints(candidates)
    expect(points).toHaveLength(2)
    for (const p of points) {
      expect(p.congestedSpanM![0]).toBeCloseTo(3000, 0)
      expect(p.congestedSpanM![1]).toBeCloseTo(5000, 0)
      expect(p.atDistanceM).toBeCloseTo(4000, 0)
      expect(p.targetSpanM[0]).toBeCloseTo(1000, 0)
      expect(p.reason).toContain("2.0 km jam on surface street (3.0 km to 5.0 km from the start)")
    }
    expect(distanceM(points.find((p) => p.side === 'left')!.position, at(4000, 500))).toBeLessThan(2)
    expect(distanceM(points.find((p) => p.side === 'right')!.position, at(4000, -500))).toBeLessThan(2)
    expectWellPlaced(points, candidates)
  })

  it('takes the congested stretch first, even when another one is longer', () => {
    // A freeway span from 6 to 10 km leaves two surface stretches: [1, 6] km and [10, 19] km.
    const spans: Partial<RouteCandidate> = { limitedAccessSpansM: [[6000, 10000]] }
    const plain = { ...world('A', 1200), ...spans }
    // Without traffic data the longer one goes first.
    expect(selectViaPoints([plain], { ...DEFAULT_PROBE_OPTIONS, maxPoints: 1 })[0]!.atDistanceM).toBeCloseTo(14500, 0)
    // A severe jam from 2 to 3 km puts the shorter one first.
    const jammed = { ...jammedA(1200, [[2000, 3000]], 'severe'), ...spans }
    const points = selectViaPoints([jammed], { ...DEFAULT_PROBE_OPTIONS, maxPoints: 4 })
    expect(points.map((p) => Math.round(p.atDistanceM))).toEqual([2500, 14500, 2500, 14500])
    expect(points.map((p) => p.congestedSpanM === null)).toEqual([false, true, false, true])
    expectWellPlaced(points, [jammed])
  })

  it('orders congested stretches by how much of each is congested', () => {
    const spans: Partial<RouteCandidate> = { limitedAccessSpansM: [[6000, 10000]] }
    // 0.5 km jammed on the short stretch, 1 km on the long one.
    const jammed = { ...jammedA(1200, [[2000, 2500], [15000, 16000]]), ...spans }
    const points = selectViaPoints([jammed], { ...DEFAULT_PROBE_OPTIONS, maxPoints: 2 })
    expect(points.map((p) => Math.round(p.atDistanceM))).toEqual([15500, 2250])
  })

  it('joins jams a short gap apart, and aims at the longest jam of a stretch', () => {
    // Heavy at 3–4 km and 4.25–5.5 km, low for the 250 m between.
    const jammed = jammedA(1200, [[3000, 4000], [4250, 5500]])
    // Default gap (200 m): two jams, the longer one is aimed at.
    const apart = selectViaPoints([jammed])
    expect(apart[0]!.congestedSpanM![0]).toBeCloseTo(4250, 0)
    expect(apart[0]!.atDistanceM).toBeCloseTo(4875, 0)
    // A 300 m gap joins them into one jam from 3 to 5.5 km.
    const joined = selectViaPoints([jammed], { ...DEFAULT_PROBE_OPTIONS, congestionGapM: 300 })
    expect(joined[0]!.congestedSpanM![0]).toBeCloseTo(3000, 0)
    expect(joined[0]!.atDistanceM).toBeCloseTo(4250, 0)
  })

  it('counts only the configured levels as congested; moderate and unknown are not jams', () => {
    const fallback = placed(selectViaPoints(WORLD()))
    for (const level of ['moderate', 'unknown', 'low'] as const) {
      const points = selectViaPoints([jammedA(1200, [[3000, 5000]], level), world('B', 1300), world('C', 1250)])
      expect(placed(points), level).toEqual(fallback)
    }
    // Unknown is never a jam, even when it is listed.
    const unknown = selectViaPoints([jammedA(1200, [[3000, 5000]], 'unknown'), world('B', 1300), world('C', 1250)], {
      ...DEFAULT_PROBE_OPTIONS,
      congestedLevels: ['unknown', 'heavy', 'severe'],
    })
    expect(placed(unknown)).toEqual(fallback)
    // With moderate counted, the same route is aimed at by the data.
    const moderate = selectViaPoints([jammedA(1200, [[3000, 5000]], 'moderate')], {
      ...DEFAULT_PROBE_OPTIONS,
      congestedLevels: ['moderate', 'heavy', 'severe'],
    })
    expect(moderate[0]!.atDistanceM).toBeCloseTo(4000, 0)
  })

  it('ignores a jam shorter than minCongestedM, and one inside the endpoint clearance', () => {
    const fallback = placed(selectViaPoints(WORLD()))
    // One 250 m segment of heavy traffic.
    expect(placed(selectViaPoints([jammedA(1200, [[4000, 4250]]), world('B', 1300), world('C', 1250)]))).toEqual(fallback)
    // Heavy for the first and last kilometer only: cut off with the clearance.
    expect(placed(selectViaPoints([jammedA(1200, [[0, 1000], [19000, 20000]]), world('B', 1300), world('C', 1250)]))).toEqual(fallback)
  })

  it('falls back to the longest stretch, unchanged, when the traffic data is missing or does not fit', () => {
    const fallback = placed(selectViaPoints(WORLD()))
    expect(fallback.every((p) => p.congestedSpanM === null)).toBe(true)
    const jammed = jammedA(1200, [[3000, 5000]])
    const variants: RouteCandidate[] = [
      { ...jammed, segmentTraffic: null },
      { ...jammed, segmentTraffic: undefined },
      { ...jammed, segmentTraffic: { congestion: null, durationSec: null } },
      // One entry short: it cannot be placed on the line.
      { ...jammed, segmentTraffic: { congestion: jammed.segmentTraffic.congestion.slice(1), durationSec: null } },
    ]
    for (const a of variants) expect(placed(selectViaPoints([a, world('B', 1300), world('C', 1250)]))).toEqual(fallback)
  })

  it('counts only congested road toward minCongestedM, not the gaps a jam is joined across', () => {
    // Two 250 m segments of heavy traffic 250 m apart: 500 m of jam with the gap, 500 m congested.
    const two = jammedA(1200, [[4000, 4250], [4500, 4750]])
    const joined = { ...DEFAULT_PROBE_OPTIONS, congestionGapM: 300 }
    expect(selectViaPoints([two], joined)[0]!.congestedSpanM).not.toBeNull()
    // Raise the bar to 600 m: the joined jam is 750 m long, but only 500 m of it is congested.
    expect(selectViaPoints([two], { ...joined, minCongestedM: 600 })[0]!.congestedSpanM).toBeNull()
  })

  it('splits a jam across a freeway span into the two stretches it touches', () => {
    // Heavy from 4 to 13 km; the freeway from 6 to 10 km leaves 2 km of it on [1, 6] and 3 km on [10, 19].
    const jammed = { ...jammedA(1200, [[4000, 13000]]), limitedAccessSpansM: [[6000, 10000]] as const }
    const points = selectViaPoints([jammed], { ...DEFAULT_PROBE_OPTIONS, maxPoints: 2 })
    expect(points.map((p) => [Math.round(p.congestedSpanM![0]), Math.round(p.congestedSpanM![1])])).toEqual([
      [10000, 13000],
      [4000, 6000],
    ])
  })

  it('is deterministic with traffic data too', () => {
    const candidates = [jammedA(1200, [[3000, 5000], [12000, 13000]]), world('B', 1300), world('C', 1250)]
    expect(selectViaPoints(candidates)).toEqual(selectViaPoints([...candidates].reverse()))
  })

  it('aims at the congested stretch on the Mapbox fixture with annotations', () => {
    const candidates = fixtureRoutes('directions.congestion.json')
    const points = selectViaPoints(candidates)
    expect(points.length).toBeGreaterThan(0)
    // The fastest route's heavy and severe segments are its 2nd and 3rd.
    const base = candidates[0]!
    const along = alongRouteM(base.geometry)
    for (const p of points) {
      expect(p.baseRouteId).toBe(base.id)
      expect(p.congestedSpanM![0]).toBeCloseTo(Math.max(along[1]!, DEFAULT_PROBE_OPTIONS.endpointClearanceM), 0)
      expect(p.congestedSpanM![1]).toBeCloseTo(Math.min(along[3]!, along.at(-1)! - DEFAULT_PROBE_OPTIONS.endpointClearanceM), 0)
    }
    expectWellPlaced(points, candidates)
  })
})

describe('side-street probes during a drive (PLAN step 11c, #5)', () => {
  /** The car on A, 1 km along: what a check from there returns. */
  const here = at(1000, 0)
  const freshA = () => candidate('A', here, 1500)!
  const freshB = () => candidate('B', here, 1600)!
  const route = world('A', 1700)

  it('has one documented budget', () => {
    expect(DEFAULT_DRIVE_PROBE_BUDGET).toEqual({ requestsPerCheck: 1, requestsPerDrive: 20 })
  })

  describe('checkProbeAllowance: probes share the drive request budget', () => {
    it('one probe per check, with room left over for the check of the current path', () => {
      // 60 requests: this check is the 10th.
      expect(checkProbeAllowance({ requestsUsed: 10, probesUsed: 3 }, 60)).toBe(1)
      // The 59th request: one is left, and it is the path check's.
      expect(checkProbeAllowance({ requestsUsed: 59, probesUsed: 3 }, 60)).toBe(0)
      expect(checkProbeAllowance({ requestsUsed: 58, probesUsed: 3 }, 60)).toBe(1)
      expect(checkProbeAllowance({ requestsUsed: 60, probesUsed: 3 }, 60)).toBe(0)
    })

    it('stops at the per-drive cap', () => {
      expect(checkProbeAllowance({ requestsUsed: 30, probesUsed: 19 }, 60)).toBe(1)
      expect(checkProbeAllowance({ requestsUsed: 30, probesUsed: 20 }, 60)).toBe(0)
      expect(checkProbeAllowance({ requestsUsed: 30, probesUsed: 25 }, 60)).toBe(0)
    })

    it('takes a budget of its own, rounded down; under 1 or not a number turns probing off', () => {
      expect(checkProbeAllowance({ requestsUsed: 1, probesUsed: 0 }, 60, { requestsPerCheck: 2 })).toBe(2)
      expect(checkProbeAllowance({ requestsUsed: 1, probesUsed: 0 }, 60, { requestsPerCheck: 2.9 })).toBe(2)
      expect(checkProbeAllowance({ requestsUsed: 1, probesUsed: 0 }, 60, { requestsPerCheck: 0.5 })).toBe(0)
      expect(checkProbeAllowance({ requestsUsed: 1, probesUsed: 0 }, 60, { requestsPerCheck: NaN })).toBe(0)
      expect(checkProbeAllowance({ requestsUsed: 1, probesUsed: 0 }, 60, { requestsPerDrive: 0 })).toBe(0)
      expect(checkProbeAllowance({ requestsUsed: NaN, probesUsed: 0 }, 60)).toBe(0)
      // Two probes on the 58th request: only one fits before the path check's room.
      expect(checkProbeAllowance({ requestsUsed: 58, probesUsed: 0 }, 60, { requestsPerCheck: 2 })).toBe(1)
    })
  })

  describe('checkProbes: where a check probes', () => {
    it('beside the route being driven, from the car, by the plan screen rules', () => {
      const fresh = [freshA(), freshB()]
      const vias = checkProbes({ route, alongM: 1000, fresh, memory: INITIAL_CHECK_PROBES, allowed: 3 })
      expect(vias).toEqual(selectViaPoints(fresh).map((p) => p.position))
      expect(vias).toHaveLength(2)
      // Clear of the car by the endpoint clearance, and of every known route.
      for (const via of vias) {
        expect(distanceM(via, here)).toBeGreaterThanOrEqual(DEFAULT_PROBE_OPTIONS.endpointClearanceM)
        for (const c of fresh) expect(lineDistanceM(via, c.geometry)).toBeGreaterThanOrEqual(DEFAULT_PROBE_OPTIONS.clearOfRoutesM)
      }
    })

    it('beside the route being driven even when another fresh route is faster', () => {
      const fresh = [candidate('A', here, 1600)!, candidate('B', here, 1400)!]
      const vias = checkProbes({ route, alongM: 1000, fresh, memory: INITIAL_CHECK_PROBES, allowed: 1 })
      // Beside A (y = 0), not beside B (1 km north): 500 m to the south, where there is more room.
      const [, y] = localProjector(at(0, 0))(vias[0]!)
      expect(y).toBeCloseTo(-500, -1)
      // With the current route not found (and no answer for it), nothing: the engine compares nothing this check,
      // and a probe could come back as the current path and stand in for it.
      expect(checkProbes({ route: world('C', 1700), alongM: 9000, fresh, memory: INITIAL_CHECK_PROBES, allowed: 1 })).toEqual([])
    })

    it('the points take turns, check by check', () => {
      const fresh = [freshA(), freshB()]
      const all = checkProbes({ route, alongM: 1000, fresh, memory: INITIAL_CHECK_PROBES, allowed: 3 })
      const turn = (round: number) => checkProbes({ route, alongM: 1000, fresh, memory: { ...INITIAL_CHECK_PROBES, round }, allowed: 1 })
      expect([turn(0), turn(1), turn(2), turn(3)]).toEqual([[all[0]], [all[1]], [all[0]], [all[1]]])
    })

    it('the via of a side street being confirmed comes first, and a point at the same place is not asked twice', () => {
      const fresh = [freshA(), freshB()]
      const all = checkProbes({ route, alongM: 1000, fresh, memory: INITIAL_CHECK_PROBES, allowed: 3 })
      const keep: LngLat = at(9000, -500)
      expect(checkProbes({ route, alongM: 1000, fresh, memory: { ...INITIAL_CHECK_PROBES, round: 1, keep }, allowed: 1 })).toEqual([keep])
      const two = checkProbes({ route, alongM: 1000, fresh, memory: { ...INITIAL_CHECK_PROBES, keep }, allowed: 2 })
      expect(two[0]).toEqual(keep)
      expect(two).toHaveLength(2)
      // A kept via right beside one of the points replaces it.
      const near: LngLat = [all[0]![0] + 0.0001, all[0]![1]]
      expect(checkProbes({ route, alongM: 1000, fresh, memory: { ...INITIAL_CHECK_PROBES, keep: near }, allowed: 3 })).toEqual([near, all[1]])
    })

    it('a kept via that is behind the car, too close to it or to the end, or on a known road is dropped', () => {
      const fresh = [freshA(), freshB()]
      const plain = checkProbes({ route, alongM: 1000, fresh, memory: INITIAL_CHECK_PROBES, allowed: 1 })
      const keeping = (keep: LngLat) => checkProbes({ route, alongM: 1000, fresh, memory: { ...INITIAL_CHECK_PROBES, keep }, allowed: 1 })
      expect(keeping(at(500, -500))).toEqual(plain) // behind the car
      expect(keeping(at(1600, -500))).toEqual(plain) // within 1 km of it
      expect(keeping(at(19500, -500))).toEqual(plain) // within 1 km of the destination
      expect(keeping(at(9000, 1000))).toEqual(plain) // on B
      expect(keeping([NaN, 35])).toEqual(plain)
    })

    it('nothing when nothing may be asked, there are no routes, or nothing is left to probe', () => {
      const fresh = [freshA(), freshB()]
      expect(checkProbes({ route, alongM: 1000, fresh, memory: INITIAL_CHECK_PROBES, allowed: 0 })).toEqual([])
      expect(checkProbes({ route, alongM: 1000, fresh: [], memory: INITIAL_CHECK_PROBES, allowed: 1 })).toEqual([])
      // 2.5 km from the end: under the 3 km a probe needs, and a kept via is not asked either.
      const near = candidate('A', at(17500, 0), 120)!
      expect(checkProbes({ route, alongM: 17500, fresh: [near], memory: { ...INITIAL_CHECK_PROBES, keep: at(19000, -500) }, allowed: 1 })).toEqual([])
    })

    it('keeps clear of the answer for the current path too', () => {
      // A is not offered; the path check answered with it.
      const vias = checkProbes({ route, alongM: 1000, fresh: [freshB()], baseline: [freshA()], memory: INITIAL_CHECK_PROBES, allowed: 3 })
      expect(vias.length).toBeGreaterThan(0)
      for (const via of vias) expect(lineDistanceM(via, freshA().geometry)).toBeGreaterThanOrEqual(DEFAULT_PROBE_OPTIONS.clearOfRoutesM)
    })
  })

  describe('mergeCheckProbes', () => {
    it('adds a new path after the fresh routes, tagged; drops one that is a fresh route or the current path asked for', () => {
      const a = freshA()
      const b = freshB()
      const s = { ...candidate('S', here, 1400)!, via: at(9000, -500) }
      const again = { ...candidate('A', here, 1450)!, via: at(9000, 500) }
      const merged = mergeCheckProbes([b], [a], [again, s])
      expect(merged.map((r) => r.id)).toEqual([b.id, s.id])
      expect(merged[1]).toMatchObject({ source: 'probe', via: s.via })
      expect(mergeCheckProbes([a, b], null, [])).toEqual([a, b])
    })
  })

  describe('rememberCheckProbes', () => {
    const s = { ...candidate('S', here, 1400)!, source: 'probe' as const, via: at(9000, -500) as LngLat }
    const b = freshB()
    const confirming = (id: string) => ({
      action: 'stay' as const,
      considered: { routeId: id, savingSec: 200, turnInM: 5000, turnAt: at(6000, 0), requiredLeadM: 400, onFreeway: false },
      nextState: { ...INITIAL_REROUTE_STATE, pending: { geometry: s.geometry, polls: 1 } },
    })

    it('keeps the via of the side street being confirmed, and counts the probes', () => {
      expect(rememberCheckProbes(INITIAL_CHECK_PROBES, 1, confirming(s.id), [b, s])).toEqual({ used: 1, round: 1, keep: s.via })
    })

    it('drops it when the route being confirmed is not a probed one, nothing is pending, or on a switch', () => {
      const memory = { used: 4, round: 4, keep: s.via }
      expect(rememberCheckProbes(memory, 1, confirming(b.id), [b, s]).keep).toBeNull()
      const none = { action: 'stay' as const, considered: confirming(s.id).considered, nextState: INITIAL_REROUTE_STATE }
      expect(rememberCheckProbes(memory, 1, none, [b, s]).keep).toBeNull()
      expect(rememberCheckProbes(memory, 1, { ...confirming(s.id), action: 'switch' }, [b, s]).keep).toBeNull()
    })

    it('a failed check keeps it, as the engine keeps its confirmation; a check without probes takes no turn', () => {
      const memory = { used: 4, round: 4, keep: s.via }
      const failed = { action: 'stay' as const, considered: null, nextState: INITIAL_REROUTE_STATE }
      expect(rememberCheckProbes(memory, 0, failed, null)).toEqual(memory)
      expect(rememberCheckProbes(memory, 0, confirming(s.id), [b, s])).toEqual({ used: 4, round: 4, keep: s.via })
    })
  })
})
