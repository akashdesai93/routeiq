import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  alongRouteM,
  DEFAULT_PROBE_OPTIONS,
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
