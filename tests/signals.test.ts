import { describe, expect, it } from 'vitest'
import {
  alongRouteM,
  clusterSignals,
  DEFAULT_SIGNAL_MATCH,
  formatSignalCount,
  signalCountNote,
  geometryHash,
  localProjector,
  pointToSegment,
  resolveSelectedId,
  routeIdFromGeometry,
  sameRouteGeometry,
  signalsOnRoute,
  signalTilesForRoute,
  tileIdAt,
  withSignalCounts,
  type LngLat,
  type RouteCandidate,
  type RouteIntersection,
  type SignalData,
  type SignalPoint,
} from '../src/core/index.ts'
import { signalFeatures } from '../src/map/signalFeatures.ts'

// Test geometry is laid out in meters around a point in Charlotte, then turned
// into coordinates, so distances in the tests read as what they are.
const HERE: LngLat = [-80.84, 35.2]
const M_PER_DEGREE = (6_371_008.8 * Math.PI) / 180
const M_PER_DEGREE_LNG = M_PER_DEGREE * Math.cos((HERE[1] * Math.PI) / 180)

/** The point `eastM` meters east and `northM` meters north of HERE. */
function at(eastM: number, northM: number): LngLat {
  return [HERE[0] + eastM / M_PER_DEGREE_LNG, HERE[1] + northM / M_PER_DEGREE]
}

function signal(id: string, eastM: number, northM: number): SignalPoint {
  return { id, position: at(eastM, northM), name: `signal ${id}` }
}

/** One kilometer due north from HERE. */
const NORTH_1KM: LngLat[] = [at(0, 0), at(0, 1000)]

function route(id: string, geometry: readonly LngLat[], durationSec = 600): RouteCandidate {
  return {
    id,
    geometry,
    durationSec,
    typicalDurationSec: null,
    distanceM: 1000,
    signalCount: null,
    signalCoverage: 'none',
    providerSignalCount: null,
    intersections: null,
    limitedAccessSpansM: null,
    maneuvers: [],
  }
}

/** Signal data with the primary tiles loaded for every one of the given routes. */
function loadedFor(
  routes: readonly RouteCandidate[],
  primary: readonly SignalPoint[],
  gapFill: readonly SignalPoint[] | null = null,
): SignalData {
  return {
    primary,
    primaryTileIds: new Set(routes.flatMap((r) => signalTilesForRoute(r.geometry))),
    gapFill,
  }
}

describe('geo helpers for signal matching', () => {
  it('localProjector gives meters east and north of its origin', () => {
    const project = localProjector(HERE)
    expect(project(HERE)).toEqual([0, 0])
    const [x, y] = project(at(300, -400))
    expect(x).toBeCloseTo(300, 6)
    expect(y).toBeCloseTo(-400, 6)
  })

  it('pointToSegment measures to the segment, not the endless line', () => {
    expect(pointToSegment([5, 3], [0, 0], [10, 0])).toEqual({ distanceM: 3, t: 0.5 })
    expect(pointToSegment([-4, 3], [0, 0], [10, 0])).toEqual({ distanceM: 5, t: 0 })
    expect(pointToSegment([13, 4], [0, 0], [10, 0])).toEqual({ distanceM: 5, t: 1 })
    // A zero-length segment is just its point.
    expect(pointToSegment([3, 4], [0, 0], [0, 0])).toEqual({ distanceM: 5, t: 0 })
  })
})

describe('signalsOnRoute', () => {
  it('documents its defaults in one place', () => {
    // The three rule distances (group 60 m, route 30 m, intersection 40 m), then the
    // gap-fill distance, the along-route merge and the freeway margin.
    expect(DEFAULT_SIGNAL_MATCH).toEqual({
      clusterRadiusM: 60,
      toleranceM: 30,
      intersectionRadiusM: 40,
      gapFillRadiusM: 60,
      mergeRadiusM: 40,
      limitedAccessMarginM: 30,
    })
  })

  it('counts a point just inside the tolerance and not one just outside', () => {
    // The tolerance is 30 m now (it was 20 m when the city list was the only source).
    const inside = signal('inside', 29.9, 300)
    const outside = signal('outside', -30.1, 700)
    const found = signalsOnRoute(NORTH_1KM, [outside, inside])
    expect(found.count).toBe(1)
    expect(found.signals).toHaveLength(1)
    const only = found.signals[0]!
    expect(only.id).toBe('inside')
    expect(only.name).toBe('signal inside')
    expect(only.position).toEqual(inside.position)
    expect(only.source).toBe('primary')
    expect(only.offsetM).toBeCloseTo(29.9, 1)
    expect(only.atDistanceM).toBeCloseTo(300, 0)
    expect(only.mergedIds).toEqual(['inside'])
  })

  it('applies the tolerance past the ends of the route too', () => {
    // The one that is too far is also far from the others, so grouping plays no part.
    const justPastEnd = signal('past-end', 0, 1029)
    const tooFarPastEnd = signal('too-far', 0, 1100)
    const beforeStart = signal('before-start', 0, -29)
    const found = signalsOnRoute(NORTH_1KM, [justPastEnd, tooFarPastEnd, beforeStart])
    expect(found.signals.map((s) => s.id)).toEqual(['before-start', 'past-end'])
    expect(found.signals[0]!.atDistanceM).toBe(0)
    expect(found.signals[1]!.atDistanceM).toBeCloseTo(1000, 0)
  })

  it('honors the tolerance it is given', () => {
    const s = [signal('a', 40, 500)]
    expect(signalsOnRoute(NORTH_1KM, s).count).toBe(0)
    expect(signalsOnRoute(NORTH_1KM, s, { toleranceM: 45 }).count).toBe(1)
    // Zero, negative or NaN means "exactly on the line", never "anywhere".
    for (const toleranceM of [0, -5, NaN]) {
      expect(signalsOnRoute(NORTH_1KM, [signal('near', 1, 600)], { toleranceM, mergeRadiusM: 40 }).count).toBe(0)
    }
  })

  it('counts duplicate signal points at one intersection once', () => {
    // Two heads of the same intersection, on either side of the road, 5 m apart along it.
    const east = signal('east', 12, 400)
    const west = signal('west', -8, 405)
    const next = signal('next', 3, 470)
    const found = signalsOnRoute(NORTH_1KM, [east, next, west])
    expect(found.count).toBe(2)
    const [first, second] = found.signals
    // The two heads are grouped first (rule a): the entry is the group, named by its
    // smallest id, placed at the middle of its points, and it remembers its members.
    expect(first!.id).toBe('east')
    expect(first!.mergedIds).toEqual(['east', 'west'])
    expect(first!.position[1]).toBeCloseTo(at(2, 402.5)[1], 9)
    expect(first!.atDistanceM).toBeCloseTo(402.5, 0)
    expect(first!.offsetM).toBeCloseTo(2, 0)
    expect(second!.id).toBe('next')
  })

  it('merges only within the merge radius, measured along the route', () => {
    // Grouping is switched off here (clusterRadiusM 0) so that only the along-route merge is at work.
    const ungrouped = { clusterRadiusM: 0 }
    const points = [signal('a', 5, 400), signal('b', -5, 439), signal('c', 5, 481)]
    // a-b are 39 m apart (one intersection); c is 81 m from a, so it stands alone.
    expect(signalsOnRoute(NORTH_1KM, points, ungrouped).signals.map((s) => s.mergedIds)).toEqual([['a', 'b'], ['c']])
    // The radius is measured from the first point of a group, so it cannot chain a-b-c together.
    const chain = [signal('a', 5, 400), signal('b', -5, 430), signal('c', 5, 460)]
    expect(signalsOnRoute(NORTH_1KM, chain, ungrouped).signals.map((s) => s.mergedIds)).toEqual([['a', 'b'], ['c']])
    expect(signalsOnRoute(NORTH_1KM, points, { ...ungrouped, mergeRadiusM: 100 }).count).toBe(1)
    expect(signalsOnRoute(NORTH_1KM, points, { ...ungrouped, mergeRadiusM: 0 }).count).toBe(3)
    // With grouping on (the default) the same chain is one intersection: each point is within 60 m of the next.
    expect(signalsOnRoute(NORTH_1KM, chain).signals.map((s) => s.mergedIds)).toEqual([['a', 'b', 'c']])
  })

  it('counts one pass once however many short segments run past the signal', () => {
    // A vertex every 5 m: about eight segments lie within 20 m of the signal.
    const dense: LngLat[] = Array.from({ length: 201 }, (_, i) => at(0, i * 5))
    const s = [signal('a', 6, 502)]
    expect(signalsOnRoute(dense, s).count).toBe(1)
    expect(signalsOnRoute(dense, s, { toleranceM: 20, mergeRadiusM: 0 }).count).toBe(1)
    expect(signalsOnRoute(dense, s).signals[0]!.atDistanceM).toBeCloseTo(502, 0)
    // Repeated vertices (zero-length segments) change nothing.
    const stutter = dense.flatMap((p) => [p, p])
    expect(signalsOnRoute(stutter, s, { toleranceM: 20, mergeRadiusM: 0 }).count).toBe(1)
  })

  it('counts a signal twice when a looping route passes it twice', () => {
    // North through the intersection at (0, 150), around the block, then west through it again.
    const loop: LngLat[] = [at(0, 0), at(0, 300), at(200, 300), at(200, 150), at(-100, 150)]
    const crossing = signal('crossing', 4, 153)
    const found = signalsOnRoute(loop, [crossing])
    expect(found.count).toBe(2)
    expect(found.signals.map((s) => s.id)).toEqual(['crossing', 'crossing'])
    expect(found.signals[0]!.atDistanceM).toBeCloseTo(153, 0)
    // 300 north + 200 east + 150 south + 196 west.
    expect(found.signals[1]!.atDistanceM).toBeCloseTo(846, 0)
    // The map draws it once.
    expect(signalFeatures(found.signals).features).toHaveLength(1)
  })

  it('counts a signal at a corner once, though both legs of the turn are near it', () => {
    const turn: LngLat[] = [at(0, 0), at(0, 500), at(500, 500)]
    const found = signalsOnRoute(turn, [signal('corner', 8, 492)])
    expect(found.count).toBe(1)
    expect(signalsOnRoute(turn, [signal('corner', 8, 492)], { toleranceM: 20, mergeRadiusM: 0 }).count).toBe(1)
  })

  it('returns signals in driving order', () => {
    const points = [signal('late', 0, 900), signal('early', 0, 100), signal('middle', 0, 500)]
    expect(signalsOnRoute(NORTH_1KM, points).signals.map((s) => s.id)).toEqual(['early', 'middle', 'late'])
    const southbound = [...NORTH_1KM].reverse()
    expect(signalsOnRoute(southbound, points).signals.map((s) => s.id)).toEqual(['late', 'middle', 'early'])
  })

  it('is empty for empty or unusable inputs', () => {
    const s = [signal('a', 0, 500)]
    const none = { signals: [], count: 0 }
    expect(signalsOnRoute([], s)).toEqual(none)
    expect(signalsOnRoute([at(0, 500)], s)).toEqual(none)
    expect(signalsOnRoute(NORTH_1KM, [])).toEqual(none)
    expect(signalsOnRoute([], [])).toEqual(none)
    expect(signalsOnRoute([[NaN, 35], [200, 35]], s)).toEqual(none)
    // Bad points are ignored, not fatal.
    const messy: LngLat[] = [at(0, 0), [NaN, NaN], at(0, 1000)]
    const badSignal: SignalPoint = { id: 'bad', position: [-80.84, 91], name: null }
    expect(signalsOnRoute(messy, [badSignal, ...s]).signals.map((x) => x.id)).toEqual(['a'])
  })

  it('handles a route that leaves the city', () => {
    // 200 km north, far past every signal, as two long segments.
    const farAway: LngLat[] = [at(0, 0), at(0, 1000), at(0, 200_000)]
    const inTown = [signal('a', 10, 300), signal('b', -10, 800), signal('off', 500, 500)]
    const found = signalsOnRoute(farAway, inTown)
    expect(found.signals.map((s) => s.id)).toEqual(['a', 'b'])
    // And one that never comes near the signals at all.
    const elsewhere: LngLat[] = [at(50_000, 50_000), at(60_000, 60_000)]
    expect(signalsOnRoute(elsewhere, inTown).count).toBe(0)
  })

  it('agrees with a brute-force count on a city-sized input', () => {
    // Deterministic pseudo-random layout: 5,000 signals over 30 x 30 km, a 3,000-vertex wandering route.
    let seed = 12345
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const signals = Array.from({ length: 5000 }, (_, i) => signal(`s${i}`, random() * 30_000, random() * 30_000))
    const line: LngLat[] = []
    let x = 2000
    let y = 2000
    for (let i = 0; i < 3000; i++) {
      line.push(at(x, y))
      x += random() * 16 - 2
      y += random() * 16 - 2
    }
    // No grouping and no merging: every signal point is judged on its own, as the brute force does.
    const options = { clusterRadiusM: 0, toleranceM: 60, mergeRadiusM: 0 }
    const found = signalsOnRoute(line, signals, options)

    // Brute force: every signal against every segment. The two use slightly
    // different plane origins, so signals within a meter of the limit are left
    // out of the comparison.
    const project = localProjector(HERE)
    const xy = line.map(project)
    const foundIds = new Set(found.signals.map((s) => s.id))
    let surelyOn = 0
    for (const s of signals) {
      const p = project(s.position)
      let nearest = Infinity
      for (let i = 1; i < xy.length; i++) {
        nearest = Math.min(nearest, pointToSegment(p, xy[i - 1]!, xy[i]!).distanceM)
      }
      if (nearest <= options.toleranceM - 1) {
        surelyOn++
        expect(foundIds.has(s.id), `${s.id} at ${nearest} m`).toBe(true)
      } else if (nearest > options.toleranceM + 1) {
        expect(foundIds.has(s.id), `${s.id} at ${nearest} m`).toBe(false)
      }
    }
    expect(surelyOn).toBeGreaterThan(5)
  })
})

describe('signalsOnRoute with limited-access spans', () => {
  // The middle of the kilometer, 200 m to 800 m, is freeway.
  const FREEWAY = { limitedAccessSpansM: [[200, 800]] as const }
  const ids = (found: { signals: readonly { id: string }[] }) => found.signals.map((s) => s.id)

  it('ignores a signal in the middle of a freeway span and keeps the ones on streets', () => {
    const points = [signal('before', 5, 100), signal('overpass', 5, 500), signal('after', 5, 900)]
    expect(ids(signalsOnRoute(NORTH_1KM, points))).toEqual(['before', 'overpass', 'after'])
    const found = signalsOnRoute(NORTH_1KM, points, DEFAULT_SIGNAL_MATCH, FREEWAY)
    expect(ids(found)).toEqual(['before', 'after'])
    expect(found.count).toBe(2)
  })

  it('keeps a signal just past the end of a span, and just before its start', () => {
    const points = [signal('on-ramp light', 0, 195), signal('ramp-end light', 0, 805)]
    expect(signalsOnRoute(NORTH_1KM, points, DEFAULT_SIGNAL_MATCH, FREEWAY).count).toBe(2)
  })

  it('keeps a signal within the margin inside either end, and drops one beyond it', () => {
    const count = (northM: number, limitedAccessMarginM?: number) =>
      signalsOnRoute(
        NORTH_1KM,
        [signal('s', 0, northM)],
        limitedAccessMarginM === undefined ? {} : { limitedAccessMarginM },
        FREEWAY,
      ).count
    // Default margin 30 m: 229 m is within it, 231 m is not; the same at the far end.
    expect([229, 231, 769, 771].map((m) => count(m))).toEqual([1, 0, 0, 1])
    // The margin can be set; 0, a negative or NaN means none.
    expect([205, 795].map((m) => count(m, 0))).toEqual([0, 0])
    expect(count(205, -10)).toBe(0)
    expect(count(205, NaN)).toBe(0)
    expect(count(260, 100)).toBe(1)
    // A span shorter than twice the margin hides nothing.
    expect(
      signalsOnRoute(NORTH_1KM, [signal('s', 0, 500)], DEFAULT_SIGNAL_MATCH, { limitedAccessSpansM: [[480, 530]] })
        .count,
    ).toBe(1)
  })

  it('behaves exactly as before with null or empty spans', () => {
    const points = [signal('a', 5, 100), signal('b', -12, 500), signal('b2', 12, 510), signal('c', 5, 900)]
    const plain = signalsOnRoute(NORTH_1KM, points)
    expect(plain.count).toBe(3)
    expect(signalsOnRoute(NORTH_1KM, points, DEFAULT_SIGNAL_MATCH, { limitedAccessSpansM: null })).toEqual(plain)
    expect(signalsOnRoute(NORTH_1KM, points, DEFAULT_SIGNAL_MATCH, { limitedAccessSpansM: [] })).toEqual(plain)
    expect(signalsOnRoute(NORTH_1KM, points, DEFAULT_SIGNAL_MATCH)).toEqual(plain)
  })

  it('handles several spans, and judges each pass of a looping route on its own', () => {
    const points = [signal('one', 0, 150), signal('two', 0, 450), signal('three', 0, 850)]
    const spans = { limitedAccessSpansM: [[100, 200], [400, 500], [700, 1000]] as const }
    expect(ids(signalsOnRoute(NORTH_1KM, points, DEFAULT_SIGNAL_MATCH, spans))).toEqual([])
    // North past the signal on a street, then around and across the same spot on a freeway:
    // only the street pass counts.
    const loop: LngLat[] = [at(0, 0), at(0, 1000), at(300, 1000), at(300, 500), at(-200, 500)]
    const crossing = [signal('s', 0, 500)]
    expect(signalsOnRoute(loop, crossing).signals.map((s) => Math.round(s.atDistanceM))).toEqual([500, 2100])
    const found = signalsOnRoute(loop, crossing, DEFAULT_SIGNAL_MATCH, { limitedAccessSpansM: [[1500, 2300]] })
    expect(found.signals.map((s) => Math.round(s.atDistanceM))).toEqual([500])
  })

  it('measures spans the way alongRouteM does', () => {
    const line: LngLat[] = [at(0, 0), at(300, 400), at(300, 1000)]
    const along = alongRouteM(line)
    expect(along).toHaveLength(3)
    expect(along[0]).toBe(0)
    expect(along[1]).toBeCloseTo(500, 0)
    expect(along[2]).toBeCloseTo(1100, 0)
    expect(alongRouteM([])).toEqual([])
    // A signal 700 m along, on the second leg, is inside a span given in those meters.
    const s = [signal('s', 300, 600)]
    expect(signalsOnRoute(line, s).signals[0]!.atDistanceM).toBeCloseTo(700, 0)
    const onSecondLeg = { limitedAccessSpansM: [[along[1]!, along[2]!]] as const }
    expect(signalsOnRoute(line, s, DEFAULT_SIGNAL_MATCH, onSecondLeg).count).toBe(0)
  })
})

describe('clusterSignals (rule a)', () => {
  it('groups the signal heads of one junction and leaves the next junction alone', () => {
    // Four heads on the corners of a big junction, 30 m apart, and a single signal 100 m up the road.
    const heads = [signal('ne', 15, 515), signal('nw', -15, 515), signal('se', 15, 485), signal('sw', -15, 485)]
    const clusters = clusterSignals([...heads, signal('up the road', 0, 615)])
    expect(clusters.map((c) => c.memberIds)).toEqual([['ne', 'nw', 'se', 'sw'], ['up the road']])
    const junction = clusters[0]!
    // Named by its smallest id, placed in the middle of its points.
    expect(junction.id).toBe('ne')
    expect(junction.name).toBe('signal ne')
    expect(junction.source).toBe('primary')
    expect(junction.members).toHaveLength(4)
    expect(junction.position[0]).toBeCloseTo(at(0, 500)[0], 9)
    expect(junction.position[1]).toBeCloseTo(at(0, 500)[1], 9)
    expect(clusters[1]!.position).toEqual(at(0, 615))
  })

  it('uses 60 m by default: 59 m apart is one intersection, 61 m is two', () => {
    expect(clusterSignals([signal('a', 0, 0), signal('b', 0, 59)])).toHaveLength(1)
    expect(clusterSignals([signal('a', 0, 0), signal('b', 0, 61)])).toHaveLength(2)
    expect(clusterSignals([signal('a', 0, 0), signal('b', 0, 61)], 70)).toHaveLength(1)
    // A chain: a-b and b-c are within reach, so a and c are one intersection though 100 m apart.
    expect(clusterSignals([signal('a', 0, 0), signal('c', 0, 100), signal('b', 0, 50)])).toHaveLength(1)
    // A radius of 0, a negative one or NaN groups nothing.
    for (const radius of [0, -5, NaN]) {
      expect(clusterSignals([signal('a', 0, 0), signal('b', 0, 1)], radius)).toHaveLength(2)
    }
  })

  it('does not depend on input order, uses a repeated point once and drops unusable ones', () => {
    const points = [signal('d', 300, 0), signal('b', 20, 0), signal('a', 0, 0), signal('c', 320, 10)]
    const expected = clusterSignals(points)
    expect(expected.map((c) => c.memberIds)).toEqual([['a', 'b'], ['c', 'd']])
    expect(clusterSignals([...points].reverse())).toEqual(expected)
    // The same node arriving from two tiles, and a point that is not on the map.
    const bad: SignalPoint = { id: 'bad', position: [-80.84, 91], name: null }
    expect(clusterSignals([...points, { ...points[2]! }, bad])).toEqual(expected)
    expect(clusterSignals([])).toEqual([])
  })
})

describe('signalsOnRoute rule (c): the route must have an intersection at the signal', () => {
  // A signal the route drives through at 300 m, and one on a road that crosses over the route at 600 m.
  const crossing = signal('crossing', 0, 300)
  const overpass = signal('overpass', 5, 600)
  const ids = (found: { signals: readonly { id: string }[] }) => found.signals.map((s) => s.id)

  it('drops a signal where the route has no intersection of its own', () => {
    const intersections = [at(0, 0), at(0, 300), at(0, 1000)]
    expect(ids(signalsOnRoute(NORTH_1KM, [crossing, overpass]))).toEqual(['crossing', 'overpass'])
    expect(ids(signalsOnRoute(NORTH_1KM, [crossing, overpass], DEFAULT_SIGNAL_MATCH, { intersections }))).toEqual([
      'crossing',
    ])
  })

  it('reaches 40 m from the signal, and the distance can be set', () => {
    const count = (northM: number, intersectionRadiusM?: number) =>
      signalsOnRoute(NORTH_1KM, [overpass], intersectionRadiusM === undefined ? {} : { intersectionRadiusM }, {
        intersections: [at(0, northM)],
      }).count
    // The overpass signal is 5 m to the side, so 39 m and 41 m along the road are just inside and just outside.
    expect([561, 559, 639, 641].map((m) => count(m))).toEqual([1, 0, 1, 0])
    expect(count(500, 120)).toBe(1)
    expect(count(600, 0)).toBe(0)
  })

  it('is skipped, not failed, for a route with no intersection list', () => {
    for (const intersections of [null, undefined, []]) {
      expect(ids(signalsOnRoute(NORTH_1KM, [crossing, overpass], DEFAULT_SIGNAL_MATCH, { intersections }))).toEqual([
        'crossing',
        'overpass',
      ])
    }
  })

  it('accepts an intersection near any signal point of the group, or its middle', () => {
    // Two heads 50 m apart along the route; the only route intersection is 35 m past the second.
    const heads = [signal('first', 0, 300), signal('second', 0, 350)]
    expect(signalsOnRoute(NORTH_1KM, heads, DEFAULT_SIGNAL_MATCH, { intersections: [at(0, 385)] }).count).toBe(1)
    expect(signalsOnRoute(NORTH_1KM, heads, DEFAULT_SIGNAL_MATCH, { intersections: [at(0, 395)] }).count).toBe(0)
  })
})

describe('withSignalCounts', () => {
  const town = [signal('a', 0, 300), signal('b', 0, 800)]
  const inside = route('inside', NORTH_1KM)
  const result = (r: RouteCandidate) => [r.signalCount, r.signalCoverage]

  it('fills the count and the coverage and keeps order and every other field', () => {
    const other = route('other', [at(1000, 0), at(1000, 1000)], 500)
    const { routes, signalsByRouteId } = withSignalCounts([inside, other], loadedFor([inside, other], town))
    expect(routes.map((r) => r.id)).toEqual(['inside', 'other'])
    expect(routes.map(result)).toEqual([
      [2, 'full'],
      [0, 'full'],
    ])
    expect(routes[0]).toEqual({ ...inside, signalCount: 2, signalCoverage: 'full' })
    expect(signalsByRouteId.get('inside')!.map((s) => s.id)).toEqual(['a', 'b'])
    expect(signalsByRouteId.get('other')).toEqual([])
    // With every tile loaded, zero is a real zero and is shown as one.
    expect(formatSignalCount(routes[1]!.signalCount, routes[1]!.signalCoverage)).toBe('0 signals')
    // The input is not changed.
    expect(inside.signalCount).toBeNull()
  })

  it('leaves the routes untouched while nothing has been loaded yet', () => {
    const counted = withSignalCounts([inside], null)
    expect(counted.routes).toEqual([inside])
    expect(result(counted.routes[0]!)).toEqual([null, 'none'])
    expect(counted.signalsByRouteId.size).toBe(0)
  })

  it('says none, with no count, when nothing at all is known about a route', () => {
    const nothing: SignalData = { primary: [], primaryTileIds: new Set(), gapFill: null }
    expect(result(withSignalCounts([inside], nothing).routes[0]!)).toEqual([null, 'none'])
    // Stray points do not help: without its tile loaded, the data says nothing about what else is there.
    const stray: SignalData = { ...nothing, primary: town }
    expect(result(withSignalCounts([inside], stray).routes[0]!)).toEqual([null, 'none'])
  })

  // Replaces "leaves the count unknown for a route that leaves the area the data covers": the box
  // around the city list is gone. What matters now is whether the tiles a route needs were loaded,
  // and a route with some of them missing gets a partial count rather than none.
  it('marks a route partial, never zero as if known, when a tile it needs is missing', () => {
    // 50 km north: far outside the tiles loaded for the short route.
    const leaving = route('leaving', [at(0, 0), at(0, 1000), at(0, 50_000)])
    const { routes, signalsByRouteId } = withSignalCounts([leaving, inside], loadedFor([inside], town))
    expect(routes.map(result)).toEqual([
      [2, 'partial'],
      [2, 'full'],
    ])
    expect(formatSignalCount(routes[0]!.signalCount, routes[0]!.signalCoverage)).toBe('≥ 2 signals (partial)')
    // What was found is still there to draw.
    expect(signalsByRouteId.get('leaving')!.map((s) => s.id)).toEqual(['a', 'b'])
    // Nothing found and data missing: the count is 0 but partial, and is never shown as "0 signals".
    const empty = withSignalCounts([leaving], loadedFor([inside], [])).routes[0]!
    expect(result(empty)).toEqual([0, 'partial'])
    expect(formatSignalCount(empty.signalCount, empty.signalCoverage)).toBe('Signals: unknown')
  })

  it('applies the limited-access spans of each route', () => {
    const freeway = { ...inside, id: 'freeway', limitedAccessSpansM: [[200, 1000]] as const }
    const { routes, signalsByRouteId } = withSignalCounts([inside, freeway], loadedFor([inside], town))
    // Signal a (300 m) is deep in the span. Signal b (800 m) is too: the span runs to the route end.
    expect(routes.map((r) => r.signalCount)).toEqual([2, 0])
    expect(signalsByRouteId.get('freeway')).toEqual([])
    // A span that ends just before b: the light at the foot of the ramp stays.
    const ramp = { ...inside, id: 'ramp', limitedAccessSpansM: [[0, 790]] as const }
    expect(
      withSignalCounts([ramp], loadedFor([inside], town))
        .signalsByRouteId.get('ramp')!
        .map((s) => s.id),
    ).toEqual(['b'])
  })

  it('applies rule (c) with the intersections of each route', () => {
    const listed = (...northM: number[]): RouteIntersection[] => northM.map((m) => ({ location: at(0, m), signal: false }))
    const through = { ...inside, id: 'through', intersections: listed(0, 300, 800, 1000) }
    const under = { ...inside, id: 'under', intersections: listed(0, 300, 1000) }
    const counted = withSignalCounts([inside, through, under], loadedFor([inside], town))
    // No list: the rule is skipped. Signal b has no route intersection on the third route.
    expect(counted.routes.map((r) => r.signalCount)).toEqual([2, 2, 1])
  })

  it('passes its options through', () => {
    const wide = withSignalCounts([inside], loadedFor([inside], [...town, signal('far', 45, 500)]), { toleranceM: 50 })
    expect(wide.routes[0]!.signalCount).toBe(3)
  })
})

describe('withSignalCounts: primary data first, gap-fill data only where it has nothing', () => {
  const inside = route('inside', NORTH_1KM)
  // Two heads of one junction at 300 m, from the primary source.
  const primary = [signal('osm-east', 10, 300), signal('osm-west', -10, 300)]

  it('ignores a gap-fill point near a primary intersection and adds one far from any', () => {
    const city = [
      signal('city-same-junction', 5, 320),
      signal('city-missing-from-primary', 0, 700),
      // Nowhere near the route: makes no difference to anything.
      signal('city-elsewhere', 20_000, 20_000),
    ]
    const { routes, signalsByRouteId } = withSignalCounts([inside], loadedFor([inside], primary, city))
    expect([routes[0]!.signalCount, routes[0]!.signalCoverage]).toEqual([2, 'full'])
    expect(signalsByRouteId.get('inside')!.map((s) => [s.id, s.source])).toEqual([
      ['osm-east', 'primary'],
      ['city-missing-from-primary', 'gapFill'],
    ])
    // Gap-fill only ever adds: the primary intersection is exactly what it is without the city list.
    const alone = withSignalCounts([inside], loadedFor([inside], primary)).signalsByRouteId.get('inside')!
    expect(signalsByRouteId.get('inside')![0]).toEqual(alone[0])
    expect(alone).toHaveLength(1)
  })

  it('measures "near" from every point of the primary intersection: 60 m by default', () => {
    const single = [signal('osm', 0, 300)]
    const count = (northM: number, gapFillRadiusM?: number) =>
      withSignalCounts(
        [inside],
        loadedFor([inside], single, [signal('city', 0, northM)]),
        gapFillRadiusM === undefined ? {} : { gapFillRadiusM },
      ).routes[0]!.signalCount
    expect([359, 361].map((m) => count(m))).toEqual([1, 2])
    expect(count(400, 120)).toBe(1)
    // The along-route merge (40 m) is still the last word: with no gap-fill distance at all,
    // a city point 30 m up the road is the same stop.
    expect(count(330, 0)).toBe(1)
  })

  it('never lets the gap-fill data decide the coverage', () => {
    const town = [signal('a', 0, 300), signal('b', 0, 800)]
    const result = (data: SignalData) => {
      const r = withSignalCounts([inside], data).routes[0]!
      return [r.signalCount, r.signalCoverage]
    }
    // A route nowhere near the city's points is still fully covered by its tiles
    // (the old rule called anything outside the box around the city list unknown).
    expect(result(loadedFor([inside], town, [signal('city', 300_000, 300_000)]))).toEqual([2, 'full'])
    // The city list failing to load changes nothing either.
    expect(result(loadedFor([inside], town, null))).toEqual([2, 'full'])
    // City list only, no tile loaded: a lower bound, so partial, never full.
    expect(result({ primary: [], primaryTileIds: new Set(), gapFill: [signal('city', 0, 300)] })).toEqual([1, 'partial'])
  })
})

describe('withSignalCounts across tiles', () => {
  // A road running east along latitude 35.25, across the tile edge at longitude -80.8.
  const WEST_TILE = '-809_352'
  const EAST_TILE = '-808_352'
  const road: LngLat[] = [
    [-80.81, 35.25],
    [-80.79, 35.25],
  ]
  const osm = (id: number, lng: number): SignalPoint => ({ id: `osm-${id}`, position: [lng, 35.25], name: null })
  const result = (r: RouteCandidate) => [r.signalCount, r.signalCoverage]

  it('needs exactly the two tiles the road is in', () => {
    expect(signalTilesForRoute(road)).toEqual([EAST_TILE, WEST_TILE])
  })

  it('counts an intersection whose signals straddle the tile edge once', () => {
    // One junction on the edge: a head 14 m west of it and one 14 m east, so in different tiles.
    const west = osm(1, -80.80015)
    const east = osm(2, -80.79985)
    expect([tileIdAt(west.position), tileIdAt(east.position)]).toEqual([WEST_TILE, EAST_TILE])
    const crossing = route('crossing', road)
    const both: SignalData = { primary: [west, east], primaryTileIds: new Set([WEST_TILE, EAST_TILE]), gapFill: null }
    const counted = withSignalCounts([crossing], both)
    expect(result(counted.routes[0]!)).toEqual([1, 'full'])
    expect(counted.signalsByRouteId.get('crossing')![0]!.mergedIds).toEqual(['osm-1', 'osm-2'])
    // A node on the edge comes back from both tiles: the same node twice is still one signal.
    const twice: SignalData = { ...both, primary: [west, east, { ...west }, { ...east }] }
    expect(result(withSignalCounts([crossing], twice).routes[0]!)).toEqual([1, 'full'])
    // With only the west tile loaded, the half that is known counts once, and the count is partial.
    const half: SignalData = { primary: [west], primaryTileIds: new Set([WEST_TILE]), gapFill: null }
    expect(result(withSignalCounts([crossing], half).routes[0]!)).toEqual([1, 'partial'])
  })

  it('falls back on the provider signal flags only in tiles whose data is missing', () => {
    const intersections: RouteIntersection[] = [
      // West tile: one the primary data has, one it does not (the primary data wins there).
      { location: [-80.807, 35.25], signal: true },
      { location: [-80.804, 35.25], signal: true },
      // East tile: two flagged approaches of one junction 9 m apart, then a plain intersection.
      { location: [-80.795, 35.25], signal: true },
      { location: [-80.7949, 35.25], signal: true },
      { location: [-80.792, 35.25], signal: false },
    ]
    const crossing = { ...route('crossing', road), intersections, providerSignalCount: 4 }
    const primary = [osm(7, -80.807)]

    const westOnly: SignalData = { primary, primaryTileIds: new Set([WEST_TILE]), gapFill: null }
    const counted = withSignalCounts([crossing], westOnly)
    expect(result(counted.routes[0]!)).toEqual([2, 'partial'])
    expect(counted.signalsByRouteId.get('crossing')!.map((s) => s.source)).toEqual(['primary', 'fallback'])
    // The provider's own count is left as it was: a cross-check, not the answer.
    expect(counted.routes[0]!.providerSignalCount).toBe(4)

    // Both tiles loaded (the east one has no signals): the flags are not used at all.
    const both: SignalData = { ...westOnly, primaryTileIds: new Set([WEST_TILE, EAST_TILE]) }
    expect(result(withSignalCounts([crossing], both).routes[0]!)).toEqual([1, 'full'])

    // No tile loaded: every flag stands in, grouped like any other signal points. Still partial.
    const none: SignalData = { primary: [], primaryTileIds: new Set(), gapFill: null }
    expect(result(withSignalCounts([crossing], none).routes[0]!)).toEqual([3, 'partial'])

    // A gap-fill point at a flagged junction is the same junction, not one more.
    const withCity: SignalData = { ...westOnly, gapFill: [{ id: 'city-1', position: [-80.79495, 35.2501], name: 'A_B' }] }
    expect(result(withSignalCounts([crossing], withCity).routes[0]!)).toEqual([2, 'partial'])
  })
})

describe('geometryHash and routeIdFromGeometry', () => {
  const a: LngLat[] = [[-80.8431, 35.2271], [-80.8436, 35.2201], [-80.8295, 35.1527]]

  it('gives the same id for the same geometry, every time', () => {
    expect(routeIdFromGeometry(a)).toBe(routeIdFromGeometry(a.map(([lng, lat]) => [lng, lat] as const)))
    expect(routeIdFromGeometry(a)).toMatch(/^route-[0-9a-f]{16}$/)
    expect(geometryHash(a)).toMatch(/^[0-9a-f]{16}$/)
    // Pinned, so a change to the hash (which would break stored ids) is noticed.
    expect(geometryHash([[0, 0], [1, 1]])).toBe('959a2e13ba3e6f92')
    expect(geometryHash([])).toBe('4b95f51520c34f4c')
    expect(routeIdFromGeometry([[-80.8431, 35.2271], [-80.8295, 35.1527]])).toBe('route-6156bfd75b6b0cbe')
  })

  it('gives different ids for different geometry', () => {
    const ids = new Set([
      geometryHash(a),
      geometryHash([...a].reverse()),
      geometryHash(a.slice(0, 2)),
      geometryHash([...a, a[2]!]),
      geometryHash(a.map(([lng, lat]) => [lat, lng] as const)),
      geometryHash([[-80.8431, 35.2271], [-80.8436, 35.2202], [-80.8295, 35.1527]]),
      geometryHash([[-80.843101, 35.2271], [-80.8436, 35.2201], [-80.8295, 35.1527]]),
      geometryHash([]),
    ])
    expect(ids.size).toBe(8)
  })

  it('ignores differences far below a meter', () => {
    const nudged = a.map(([lng, lat]) => [lng + 2e-8, lat - 2e-8] as const)
    expect(geometryHash(nudged)).toBe(geometryHash(a))
  })

  it('does not collide across many nearby routes', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 2000; i++) ids.add(geometryHash([at(0, 0), at(i, 500), at(0, 1000)]))
    expect(ids.size).toBe(2000)
  })
})

describe('sameRouteGeometry and resolveSelectedId', () => {
  const path: LngLat[] = [at(0, 0), at(0, 400), at(300, 400), at(300, 900)]
  // The same roads as Mapbox returned them minutes later: an extra vertex, points under a meter off.
  const jittered: LngLat[] = [at(0, 0), at(0.4, 200), at(0, 400.6), at(300, 400), at(300.5, 650), at(300, 900)]
  // Shares the start and end but takes the next street over for a stretch.
  const alternative: LngLat[] = [at(0, 0), at(0, 400), at(150, 400), at(150, 900), at(300, 900)]

  it('matches the same path with slightly different points, and nothing else', () => {
    expect(sameRouteGeometry(path, path)).toBe(true)
    expect(sameRouteGeometry(path, jittered)).toBe(true)
    expect(sameRouteGeometry(jittered, path)).toBe(true)
    expect(sameRouteGeometry(path, alternative)).toBe(false)
    expect(sameRouteGeometry(path, [...path].reverse())).toBe(false)
    expect(sameRouteGeometry(path, path.slice(0, 3))).toBe(false)
    expect(sameRouteGeometry(path, [])).toBe(false)
    expect(sameRouteGeometry([], [])).toBe(false)
    // A lane's width apart is the same route only if the tolerance says so.
    const shifted = path.map((_, i) => at([12, 12, 312, 312][i]!, [0, 412, 412, 900][i]!))
    expect(sameRouteGeometry(path, shifted)).toBe(false)
    expect(sameRouteGeometry(path, shifted, 30)).toBe(true)
  })

  it('keeps the picked route selected while it keeps coming back', () => {
    const fast = route('fast', alternative, 500)
    const picked = route('picked', path, 700)
    expect(resolveSelectedId([fast, picked], picked)).toBe('picked')
    // Refetched: same roads, new points, so a new id. Still the selected one.
    const again = route(routeIdFromGeometry(jittered), jittered, 720)
    expect(again.id).not.toBe(routeIdFromGeometry(path))
    expect(resolveSelectedId([fast, again], picked)).toBe(again.id)
  })

  it('falls back to the top-ranked route when there is no pick or it is gone', () => {
    const fast = route('fast', alternative, 500)
    const slow = route('slow', [at(0, 0), at(-300, 500), at(300, 900)], 900)
    expect(resolveSelectedId([slow, fast], null)).toBe('fast')
    expect(resolveSelectedId([slow, fast], route('gone', path))).toBe('fast')
    expect(resolveSelectedId([], route('gone', path))).toBeNull()
    expect(resolveSelectedId([], null)).toBeNull()
    // Top-ranked is not always the fastest: within the tie window, fewer signals wins.
    const calm = { ...slow, id: 'calm', durationSec: 520, signalCount: 4, signalCoverage: 'full' as const }
    const busy = { ...fast, signalCount: 9, signalCoverage: 'full' as const }
    expect(resolveSelectedId([busy, calm], null)).toBe('calm')
    expect(resolveSelectedId([busy, calm], null, { etaTieWindowSec: 10 })).toBe('fast')
    // A pick still beats the ranking.
    expect(resolveSelectedId([busy, calm], busy)).toBe('fast')
  })
})

describe('formatSignalCount', () => {
  it('counts in words and never shows an unknown count as zero', () => {
    expect(formatSignalCount(14)).toBe('14 signals')
    expect(formatSignalCount(1)).toBe('1 signal')
    expect(formatSignalCount(0)).toBe('0 signals')
    expect(formatSignalCount(null)).toBe('Signals: unknown')
    expect(formatSignalCount(NaN)).toBe('Signals: unknown')
    expect(formatSignalCount(-1)).toBe('Signals: unknown')
    expect(formatSignalCount(2.5)).toBe('Signals: unknown')
  })

  it('shows a partial count as a lower bound, and never as a plain number or as zero', () => {
    expect(formatSignalCount(9, 'partial')).toBe('≥ 9 signals (partial)')
    expect(formatSignalCount(1, 'partial')).toBe('≥ 1 signal (partial)')
    // "At least 0" says nothing, and "0 signals" would be a claim: unknown it is.
    expect(formatSignalCount(0, 'partial')).toBe('Signals: unknown')
    expect(formatSignalCount(null, 'partial')).toBe('Signals: unknown')
    expect(formatSignalCount(14, 'none')).toBe('Signals: unknown')
    expect(formatSignalCount(null, 'none')).toBe('Signals: unknown')
    expect(formatSignalCount(14, 'full')).toBe('14 signals')
    expect(formatSignalCount(0, 'full')).toBe('0 signals')
  })

  it('explains a count that is not whole, and says nothing about one that is', () => {
    expect(signalCountNote(24, 'full')).toBeNull()
    expect(signalCountNote(0, 'full')).toBeNull()
    expect(signalCountNote(9, 'partial')).toBe('Signal data for part of this route is missing, so this is a lower bound.')
    // Where the label says unknown, so does the note.
    for (const [count, coverage] of [[0, 'partial'], [null, 'partial'], [null, 'none'], [14, 'none']] as const) {
      expect(formatSignalCount(count, coverage)).toBe('Signals: unknown')
      expect(signalCountNote(count, coverage)).toBe('Signal data for this route could not be loaded.')
    }
  })
})

describe('signalFeatures', () => {
  it('makes one point per signal at the signal position', () => {
    const found = signalsOnRoute(NORTH_1KM, [signal('a', 5, 300), { id: 'b', position: at(0, 700), name: null }])
    const fc = signalFeatures(found.signals)
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features).toEqual([
      { type: 'Feature', properties: { id: 'a', name: 'signal a' }, geometry: { type: 'Point', coordinates: [...at(5, 300)] } },
      { type: 'Feature', properties: { id: 'b', name: '' }, geometry: { type: 'Point', coordinates: [...at(0, 700)] } },
    ])
    expect(signalFeatures([]).features).toEqual([])
  })
})
