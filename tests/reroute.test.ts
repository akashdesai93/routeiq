import { describe, expect, it } from 'vitest'
import {
  alongRouteM,
  baselineProbe,
  bearingDeg,
  checkProbes,
  decideReroute,
  declineRoute,
  DEFAULT_REROUTE_OPTIONS,
  findCurrentRoute,
  INITIAL_CHECK_PROBES,
  INITIAL_REROUTE_STATE,
  lineFrom,
  localProjector,
  mergeCheckProbes,
  pointAtDistance,
  pointToSegment,
  rememberCheckProbes,
  type CheckProbeMemory,
  type DriveProbeBudget,
  type LngLat,
  type MatchMeter,
  type RerouteDecision,
  type RerouteOptions,
  type RerouteState,
  type RouteCandidate,
} from '../src/core/index.ts'
import { at, candidate, drive, lineOf, nameOf, type DriveScript, type PollContext, type RouteName } from './helpers/driveWorld.ts'

// PLAN step 7: scripted drives through the reroute engine on a fake clock and a made-up road
// network (see helpers/driveWorld.ts). No network, no timers; every position is invented.

/** ETAs by route name; a name left out is not offered. */
type Etas = Partial<Record<RouteName, number>>
const fixed = (etas: Etas) => (name: RouteName) => etas[name] ?? null

interface PollSetup {
  /** Meters along the main road A, which is the route being driven. */
  xM: number
  etas: Etas
  speedMps?: number
  nowSec?: number
  state?: RerouteState
  options?: Partial<RerouteOptions>
  /** Changes to the candidate of a route, by name. */
  extra?: Partial<Record<RouteName, Partial<RouteCandidate>>>
  /** What a request for the current path itself came back with (ETAs by route name). Left out: not asked. */
  baseline?: Etas
}

/** One poll while driving the main road A, x meters along it. */
function pollOnA(setup: PollSetup): RerouteDecision & { candidates: RouteCandidate[] } {
  const here = at(setup.xM, 0)
  const made = (etas: Etas) =>
    (Object.keys(etas) as RouteName[])
      .map((name) => candidate(name, here, etas[name]!, setup.extra?.[name]))
      .filter((c): c is RouteCandidate => c !== null)
  const candidates = made(setup.etas)
  const decision = decideReroute(
    setup.state ?? INITIAL_REROUTE_STATE,
    {
      nowSec: setup.nowSec ?? 0,
      route: { geometry: candidate('A', at(0, 0), 2000)!.geometry, maneuvers: [], limitedAccessSpansM: null },
      positionAlongM: setup.xM,
      speedMps: setup.speedMps ?? 5,
      candidates,
      baseline: setup.baseline === undefined ? undefined : made(setup.baseline),
    },
    setup.options,
  )
  return { ...decision, candidates }
}

/** Switch on the first winning poll, for tests that are about one rule only. */
const NO_CONFIRM = { confirmPolls: 1 }

describe('reroute thresholds', () => {
  it('has one documented set of defaults', () => {
    expect(DEFAULT_REROUTE_OPTIONS).toEqual({
      minSavingSec: 120,
      minSavingFraction: 0.05,
      confirmPolls: 2,
      cooldownSec: 300,
      noReturnSec: 600,
      returnSavingFactor: 2,
      minLeadDistanceM: 400,
      minLeadTimeSec: 20,
      freewayLeadDistanceM: 1200,
      routeLostPolls: 3,
      routeLostWindowSec: 900,
      offRouteM: 50,
      sameRouteToleranceM: 10,
      matchToleranceM: 20,
      matchMinOverlap: 0.95,
      matchMaxGapM: 400,
      matchMaxDivergenceM: 50,
      matchIgnoreStartM: 150,
      matchStartSearchM: 200,
      baselineViaSpacingM: 3000,
      baselineMaxViaPoints: 6,
      returnOverlapFraction: 0.5,
      requireTypicalDuration: true,
      etaTieWindowSec: 30,
    })
  })

  it('falls back to the default for a threshold that is negative or not a number', () => {
    const odd = { minSavingSec: NaN, minLeadDistanceM: -1, confirmPolls: 0 }
    // 150 s saved clears the default 120 s; confirmPolls 0 is read as 1.
    expect(pollOnA({ xM: 1000, etas: { A: 2000, B: 1850 }, options: odd }).action).toBe('switch')
    expect(pollOnA({ xM: 1000, etas: { A: 2000, B: 1890 }, options: odd }).code).toBe('saving-too-small')
    expect(pollOnA({ xM: 4700, etas: { A: 2000, B: 1850 }, options: odd }).code).toBe('too-late')
  })
})

describe('line helpers the engine and the simulated drive share', () => {
  const line = [at(0, 0), at(1000, 0), at(1000, 500)]

  it('pointAtDistance walks the line and reports the heading', () => {
    const start = pointAtDistance(line, 0)!
    expect(start.index).toBe(0)
    expect(start.bearingDeg).toBeCloseTo(90, 0)
    const mid = pointAtDistance(line, 400)!
    expect(alongRouteM([line[0]!, mid.point])[1]).toBeCloseTo(400, 0)
    const up = pointAtDistance(line, 1200)!
    expect(up.index).toBe(1)
    expect(up.bearingDeg).toBeCloseTo(0, 0)
    // Clamped at both ends; an empty line has no point.
    expect(pointAtDistance(line, -50)!.point).toEqual(line[0])
    expect(pointAtDistance(line, 99_999)!.point).toEqual(line[2])
    expect(pointAtDistance(line, NaN)!.point).toEqual(line[0])
    expect(pointAtDistance([], 10)).toBeNull()
    expect(pointAtDistance([line[0]!], 10)).toEqual({ point: line[0], index: 0, bearingDeg: 0 })
  })

  it('lineFrom is the rest of the line from a distance on', () => {
    const rest = lineFrom(line, 400)
    expect(rest).toHaveLength(3)
    expect(alongRouteM(rest).at(-1)).toBeCloseTo(alongRouteM(line).at(-1)! - 400, 0)
    // On a vertex, the vertex is not listed twice.
    expect(lineFrom(line, alongRouteM(line)[1]!)).toEqual([line[1], line[2]])
    expect(lineFrom(line, 0)).toEqual(line)
    expect(lineFrom(line, 99_999)).toEqual([line[2]])
    expect(lineFrom([], 5)).toEqual([])
  })

  it('bearingDeg runs clockwise from north', () => {
    expect(bearingDeg(at(0, 0), at(0, 100))).toBeCloseTo(0, 0)
    expect(bearingDeg(at(0, 0), at(100, 0))).toBeCloseTo(90, 0)
    expect(bearingDeg(at(0, 0), at(0, -100))).toBeCloseTo(180, 0)
    expect(bearingDeg(at(0, 0), at(-100, 0))).toBeCloseTo(270, 0)
  })
})

describe('findCurrentRoute: which fresh candidate is the rest of the current route', () => {
  const driven = candidate('B', at(0, 0), 2000)!

  it('matches by path, never by id, from wherever the driver is', () => {
    const here = at(3000, 0)
    const fresh = [candidate('A', here, 1500)!, candidate('B', here, 1600)!, candidate('C', here, 1700)!]
    expect(fresh.map((c) => c.id)).not.toContain(driven.id)
    expect(nameOf(findCurrentRoute(driven, 3000, fresh)!)).toBe('B')
    // The same id on another road proves nothing.
    const impostor = { ...fresh[0]!, id: driven.id }
    expect(findCurrentRoute(driven, 3000, [impostor, fresh[2]!])).toBeNull()
  })

  it('tolerates the few meters a provider moves points between polls, and fewer or more vertices', () => {
    const fresh = candidate('B', at(3000, 0), 1600)!
    const nudged = fresh.geometry.map(([lng, lat], i): LngLat => [lng, lat + (i % 2 === 0 ? 3 : -3) / 111_195])
    const thinned = fresh.geometry.filter((_, i, all) => i % 2 === 0 || i === all.length - 1)
    expect(findCurrentRoute(driven, 3000, [{ ...fresh, geometry: nudged }])).not.toBeNull()
    expect(findCurrentRoute(driven, 3000, [{ ...fresh, geometry: thinned }])).not.toBeNull()
    // The next street over is not the same route.
    const shifted = fresh.geometry.map(([lng, lat]): LngLat => [lng, lat + 30 / 111_195])
    expect(findCurrentRoute(driven, 3000, [{ ...fresh, geometry: shifted }])).toBeNull()
    // Nor is a route that stops short of the destination.
    expect(findCurrentRoute(driven, 3000, [{ ...fresh, geometry: fresh.geometry.slice(0, -4) }])).toBeNull()
    expect(findCurrentRoute(driven, 3000, [])).toBeNull()
  })
})

describe('findCurrentRoute at a route that crosses itself (#74)', () => {
  // East along y = 0, under a bridge at (3000, 0), round a loop (3150, 0) > (3150, -150) >
  // (3000, -150), then north over the bridge along x = 3000. The car is 3000 m along, at the
  // crossing; the fresh route is the true rest of the route.
  const toCandidate = (id: string, geometry: LngLat[]): RouteCandidate => ({
    ...candidate('A', at(0, 0), 600)!,
    id,
    geometry,
    distanceM: alongRouteM(geometry).at(-1)!,
    maneuvers: [],
  })
  const loop = [at(3150, 0), at(3150, -150), at(3000, -150), at(3000, 0), at(3000, 6000)]
  const driven = toCandidate('driven', [at(0, 0), at(3000, 0), ...loop])
  const rest = (start: LngLat) => toCandidate('rest', [start, ...loop])

  it('matches when the fresh start is nearer the later pass than the one being driven', () => {
    // 0.8 m beside the line and 0.3 m before the crossing, as Mapbox can snap a start.
    expect(findCurrentRoute(driven, 3000, [rest(at(2999.7, 0.8))])).not.toBeNull()
    // Control: 5 m before the crossing it always matched.
    expect(findCurrentRoute(driven, 2995, [rest(at(2995, 0.8))])).not.toBeNull()
  })

  it('looks for the start on the first matchStartSearchM of the path, then on the whole of it', () => {
    // Only the first stretch is looked at while the start is on it: the later pass, 650 m on, is not.
    expect(findCurrentRoute(driven, 3000, [rest(at(2999.7, 0.8))], { matchStartSearchM: 649 })).not.toBeNull()
    // A window that reaches the later pass lets it win again: the window must be shorter than the loop.
    expect(findCurrentRoute(driven, 3000, [rest(at(2999.7, 0.8))], { matchStartSearchM: 700 })).toBeNull()
    // A fresh route fetched from further on than the position says (a stale position, 300 m
    // behind, so beyond the window) is still found on the whole path.
    const straight = candidate('A', at(0, 0), 2000)!
    expect(findCurrentRoute(straight, 2700, [candidate('A', at(3000, 0), 1700)!])).not.toBeNull()
  })

  it('a poll at the crossing keeps the current route and its count', () => {
    const decision = decideReroute(INITIAL_REROUTE_STATE, {
      nowSec: 0,
      route: driven,
      positionAlongM: 3000,
      speedMps: 15,
      candidates: [rest(at(2999.7, 0.8))],
    })
    expect(decision.code).not.toBe('route-unconfirmed')
    expect(decision.current).not.toBeNull()
  })
})

// The shapes below are the ones measured on real answers (README, "Why the matching is by
// overlap"), redrawn by hand on the made-up plane. Every position is invented.
describe('the same route, drawn differently (patterns measured on real answers)', () => {
  type Corner = readonly [xM: number, yM: number]
  const line = (corners: readonly Corner[]): LngLat[] => corners.map(([x, y]) => at(x, y))
  /** A fresh route along the corners, as a provider would return it. */
  const fresh = (corners: readonly Corner[], durationSec = 1500): RouteCandidate => {
    const geometry = line(corners)
    return { ...candidate('A', at(0, 0), durationSec)!, id: `fresh-${corners.length}-${durationSec}`, geometry, distanceM: alongRouteM(geometry).at(-1)!, maneuvers: [] }
  }
  /** The main road A, straight east, being driven; the car is 3 km along it. */
  const onA = candidate('A', at(0, 0), 2000)!
  const HERE = 3000
  const isCurrent = (corners: readonly Corner[]) => findCurrentRoute(onA, HERE, [fresh(corners)]) !== null

  it('different vertex density: a bend drawn with 4 points or with 46 is the same road', () => {
    // East for 2 km, a quarter circle of 300 m radius to the north, then north.
    const bend = (stepDeg: number): Corner[] => {
      const arc: Corner[] = []
      for (let deg = -90; deg <= 0; deg += stepDeg) arc.push([2000 + 300 * Math.cos((deg * Math.PI) / 180), 300 + 300 * Math.sin((deg * Math.PI) / 180)])
      return [...arc, [2300, 5000]]
    }
    const driven = { geometry: line([[0, 0], ...bend(2)]) }
    // The coarse drawing cuts 10.2 m inside the fine one at each chord: more than the old 10 m, vertex by vertex.
    const coarse = fresh([[500, 0], ...bend(30)])
    expect(findCurrentRoute(driven, 500, [coarse])).toBe(coarse)
    // And the other way round: driving the coarse drawing, offered the fine one.
    const fine = fresh([[500, 0], ...bend(2)])
    expect(findCurrentRoute({ geometry: line([[0, 0], ...bend(30)]) }, 500, [fine])).toBe(fine)
  })

  it('a different first 150 m: snapped to the parallel street, joining a block later', () => {
    expect(isCurrent([[HERE, 40], [3120, 40], [3140, 0], [20000, 0]])).toBe(true)
    // The same beginning that never joins is another road.
    expect(isCurrent([[HERE, 40], [19980, 40], [20000, 0]])).toBe(false)
  })

  it('a divided road: the other drawing of the carriageway, 14 m to the side for 6 km', () => {
    expect(isCurrent([[HERE, 0], [6000, 0], [6010, 14], [11990, 14], [12000, 0], [20000, 0]])).toBe(true)
  })

  it('one corner cut 14 m inside the old one', () => {
    const onB = candidate('B', at(0, 0), 2000)!
    // B turns north at 5 km; the fresh drawing starts the turn 20 m early.
    const cut = fresh([[HERE, 0], [4980, 0], [5000, 20], [5000, 1000], [15000, 1000], [15000, 0], [20000, 0]])
    expect(findCurrentRoute(onB, HERE, [cut])).toBe(cut)
  })

  it('the other lane group at a freeway exit: three short stretches up to 39 m apart', () => {
    const exit: Corner[] = [
      [HERE, 0], [9000, 0], [9030, 22], [9270, 22], [9300, 0], [9420, 0], [9440, 39], [9580, 39], [9600, 0],
      [9750, 0], [9770, 38], [9910, 38], [9930, 0], [20000, 0],
    ]
    expect(isCurrent(exit)).toBe(true)
    // It is the current route for the ETA, and never an alternative to it, whatever time it claims.
    const decision = decideReroute(INITIAL_REROUTE_STATE, {
      nowSec: 0,
      route: onA,
      positionAlongM: HERE,
      speedMps: 20,
      candidates: [fresh(exit, 1400), candidate('A', at(HERE, 0), 2000)!],
    })
    expect(decision).toMatchObject({ action: 'stay', code: 'no-alternative', current: { durationSec: 2000, asked: false } })
    // Offered alone, its time is the current route's time.
    const alone = decideReroute(INITIAL_REROUTE_STATE, { nowSec: 0, route: onA, positionAlongM: HERE, speedMps: 20, candidates: [fresh(exit, 1400)] })
    expect(alone).toMatchObject({ action: 'stay', code: 'no-alternative', current: { durationSec: 1400 } })
  })

  it('a genuinely different route that shares four fifths is still a different route', () => {
    // 17 km to go; for 4 km of them it runs on the next road, 300 m north.
    const detour: Corner[] = [[HERE, 0], [10000, 0], [10000, 300], [14000, 300], [14000, 0], [20000, 0]]
    expect(isCurrent(detour)).toBe(false)
    // Even a frontage road 30 m to the side, for the same 4 km.
    expect(isCurrent([[HERE, 0], [10000, 0], [10010, 30], [13990, 30], [14000, 0], [20000, 0]])).toBe(false)
    // And a 700 m detour that would fit inside the 5% allowance of a long route: one stretch apart is too long.
    expect(isCurrent([[HERE, 0], [10000, 0], [10000, 100], [10500, 100], [10500, 0], [20000, 0]])).toBe(false)
    // A route that overshoots and comes back along the same road is never apart, but it is longer.
    expect(isCurrent([[HERE, 0], [10000, 0], [10000, 15], [9000, 15], [9000, 0], [20000, 0]])).toBe(false)
    // So it is weighed as an alternative: five minutes faster than the current route, it starts a confirmation.
    const decision = decideReroute(INITIAL_REROUTE_STATE, {
      nowSec: 0,
      route: onA,
      positionAlongM: HERE,
      speedMps: 20,
      candidates: [candidate('A', at(HERE, 0), 2000)!, fresh(detour, 1700)],
    })
    expect(decision).toMatchObject({ action: 'stay', code: 'confirming', considered: { savingSec: 300 } })
    expect(decision.considered!.turnInM).toBeCloseTo(7000, -2)
  })

  // Where the overlap rule's loose side ends (#41). A stretch apart shorter than matchMaxGapM
  // that fits in the 5% allowance used to pass however far to the side it ran, so one city
  // block around matched as the current route on a long trip, and a reroute round a closed
  // block kept the old guidance until off-route fired. Now no point of a stretch apart may
  // run farther than matchMaxDivergenceM (50 m) from the other line: above the farthest
  // measured drawing quirk (39 m, the lane group above), below any street a block over.
  /** North one 125 m block at xM (or `sideM` to the side), east `blocks` blocks, and back down to the main road. */
  const around = (xM: number, blocks: number, sideM = 125): Corner[] => [[xM, 0], [xM, sideM], [xM + 125 * blocks, sideM], [xM + 125 * blocks, 0]]
  const oneBlock: Corner[] = [[HERE, 0], ...around(10000, 1), [20000, 0]]

  it('one block around is another route, on a long trip too (#41)', () => {
    // 17 km to go, about 340 m of the fresh line apart: inside the length and share limits, 125 m to the side.
    expect(isCurrent(oneBlock)).toBe(false)
    // The divergence cap, either side of 50 m: 300 m of road 45 m to the side is still a drawing of
    // the same road; 60 m is the next street.
    expect(isCurrent([[HERE, 0], ...around(10000, 2.4, 45), [20000, 0]])).toBe(true)
    expect(isCurrent([[HERE, 0], ...around(10000, 2.4, 60), [20000, 0]])).toBe(false)
    expect(findCurrentRoute(onA, HERE, [fresh([[HERE, 0], ...around(10000, 2.4, 60), [20000, 0]])], { matchMaxDivergenceM: 70 })).not.toBeNull()
    // Two blocks, or one with 5 km to go, were already another route.
    expect(isCurrent([[HERE, 0], ...around(10000, 2), [20000, 0]])).toBe(false)
    expect(findCurrentRoute(onA, 15000, [fresh([[15000, 0], ...around(17000, 1), [20000, 0]])])).toBeNull()
    // So it is weighed as an alternative like any other: five minutes faster, it starts a confirmation.
    const both = decideReroute(INITIAL_REROUTE_STATE, {
      nowSec: 0,
      route: onA,
      positionAlongM: HERE,
      speedMps: 20,
      candidates: [fresh(oneBlock, 1700), candidate('A', at(HERE, 0), 2000)!],
    })
    expect(both).toMatchObject({ action: 'stay', code: 'confirming', considered: { savingSec: 300 } })
  })

  it('a closed block ahead: the provider routes round it, the block itself is asked for, and three "no route" answers take the detour (#41)', () => {
    // Every check, the provider's only answer goes round the block at 10 km; the main road is closed there.
    let state = INITIAL_REROUTE_STATE
    const decisions: RerouteDecision[] = []
    for (let poll = 0; poll < 3; poll++) {
      const x = HERE + 600 * poll
      const detour = fresh([[x, 0], ...around(10000, 1), [20000, 0]], 1700)
      // Not the current route any more, so its time is asked for, with one via point: on the closed block itself.
      const probe = baselineProbe(onA, x, [detour])!
      expect(probe.via).toHaveLength(1)
      const viaX = alongRouteM([at(0, 0), probe.via[0]!.point])[1]!
      expect(viaX).toBeGreaterThan(10000)
      expect(viaX).toBeLessThan(10125)
      // The provider finds no route through it.
      const decision = decideReroute(state, { nowSec: 60 * poll, route: onA, positionAlongM: x, speedMps: 10, candidates: [detour], baseline: [] })
      decisions.push(decision)
      state = decision.nextState
    }
    expect(decisions.map((d) => d.code)).toEqual(['route-unconfirmed', 'route-unconfirmed', 'route-lost'])
    expect(decisions[2]).toMatchObject({ action: 'switch', toRouteId: fresh(oneBlock, 1700).id })
    expect(decisions[2]!.reason).toMatch(/^Switching: the road ahead can no longer be routed, turn in /)
  })

  it('a confirmation carries on when the same alternative comes back drawn a little differently', () => {
    const first = decideReroute(INITIAL_REROUTE_STATE, {
      nowSec: 0,
      route: onA,
      positionAlongM: 1000,
      speedMps: 15,
      candidates: [candidate('A', at(1000, 0), 2000)!, candidate('B', at(1000, 0), 1700)!],
    })
    expect(first).toMatchObject({ action: 'stay', code: 'confirming' })
    // B again a minute later, its corner at 5 km cut 14 m inside: still the route being confirmed.
    const redrawn = fresh([[1900, 0], [4980, 0], [5000, 20], [5000, 1000], [15000, 1000], [15000, 0], [20000, 0]], 1650)
    const second = decideReroute(first.nextState, {
      nowSec: 60,
      route: onA,
      positionAlongM: 1900,
      speedMps: 15,
      candidates: [candidate('A', at(1900, 0), 1950)!, redrawn],
    })
    expect(second).toMatchObject({ action: 'switch', code: 'faster-route', toRouteId: redrawn.id })
    // Another road in its place starts the count again.
    const other = decideReroute(first.nextState, {
      nowSec: 60,
      route: onA,
      positionAlongM: 1900,
      speedMps: 15,
      candidates: [candidate('A', at(1900, 0), 1950)!, candidate('C', at(1900, 0), 1650)!],
    })
    expect(other).toMatchObject({ action: 'stay', code: 'confirming' })
    expect(other.nextState.pending?.polls).toBe(1)
  })

  it('route gone from the answers while the driver is on the road: stays; gone and off the road: a new route at once', () => {
    const others = [candidate('B', at(HERE, 0), 1500)!, candidate('C', at(HERE, 0), 1600)!]
    const observation = { nowSec: 0, route: onA, positionAlongM: HERE, speedMps: 15, candidates: others }
    let state = INITIAL_REROUTE_STATE
    for (let poll = 0; poll < 10; poll++) {
      const decision = decideReroute(state, { ...observation, nowSec: poll * 60 })
      expect(decision).toMatchObject({ action: 'stay', code: 'route-unconfirmed' })
      state = decision.nextState
    }
    // The tracker says the car has left the route: that, not the list of routes, is the reason to change.
    const off = decideReroute(state, { ...observation, nowSec: 600, offRouteM: 80 })
    expect(off).toMatchObject({ action: 'switch', code: 'off-route', toRouteId: others[0]!.id })
  })
})

describe('baselineProbe: how to ask for the current route when it is not offered', () => {
  const onA = candidate('A', at(0, 0), 2000)!
  const here = at(3000, 0)
  /** Where along the main road each via point is, to the nearest 100 m (the stretches are found in 10 m steps). */
  const xOf = (via: readonly { point: LngLat }[]) => via.map((v) => Math.round(alongRouteM([at(0, 0), v.point])[1]! / 100) * 100)

  it('asks nothing when the current route is among the fresh routes, or there are none', () => {
    expect(baselineProbe(onA, 3000, [candidate('A', here, 1500)!, candidate('B', here, 1400)!])).toBeNull()
    expect(baselineProbe(onA, 3000, [])).toBeNull()
  })

  it('puts via points on the stretches the fresh routes leave, with the heading of travel', () => {
    // B leaves the main road between 5 and 15 km, C between 8 and 12 km: one set of points pins both.
    const probe = baselineProbe(onA, 3000, [candidate('B', here, 1400)!, candidate('C', here, 1450)!])!
    expect(xOf(probe.via)).toEqual([6300, 8800, 11300, 13700])
    probe.via.forEach((v) => {
      expect(v.bearingDeg).toBeCloseTo(90, 0)
      // On the main road itself.
      expect(Math.abs(v.point[1] - at(0, 0)[1]) * 111_195).toBeLessThan(1)
    })
    // A short loop near the end gets a point of its own.
    const withE = baselineProbe(onA, 3000, [candidate('B', here, 1400)!, candidate('E', here, 1450)!])!
    expect(xOf(withE.via)).toEqual([6300, 8800, 11300, 13700, 19000])
  })

  it('never more than the cap, spread over the way', () => {
    const probe = baselineProbe(onA, 3000, [candidate('B', here, 1400)!, candidate('E', here, 1450)!], { baselineMaxViaPoints: 2 })!
    expect(xOf(probe.via)).toEqual([8800, 13700])
  })
})

describe('scripted drives', () => {
  it('oscillating ETAs: A and B trade places every poll, and nothing ever switches', () => {
    const log = drive({
      polls: 14,
      eta: (name, { poll }) => (name === 'A' ? 2000 : name === 'B' ? (poll % 2 === 0 ? 1800 : 2200) : null),
    })
    expect(log.polls).toHaveLength(14)
    expect(log.switches).toEqual([])
    expect(log.codes).toEqual(Array.from({ length: 14 }, (_, i) => (i % 2 === 0 ? 'confirming' : 'current-best')))
    expect(log.polls[0]!.decision.reason).toBe('Staying: faster route saves 3.3 minutes, confirming, check 1 of 2')
    expect(log.polls[1]!.decision.reason).toBe('Staying: current route is still the fastest')
  })

  it('oscillating winners: a different alternative wins each poll, and nothing ever switches', () => {
    const log = drive({
      polls: 14,
      eta: (name, { poll }) =>
        name === 'A' ? 2000 : name === 'B' ? (poll % 2 === 0 ? 1700 : 1950) : name === 'C' ? (poll % 2 === 0 ? 1950 : 1700) : null,
    })
    expect(log.switches).toEqual([])
    expect(new Set(log.codes)).toEqual(new Set(['confirming']))
    expect(log.polls.every((p) => p.decision.nextState.pending?.polls === 1)).toBe(true)
  })

  it('a steady 3 minute gain: exactly one switch, on the second poll that confirms it', () => {
    const log = drive({ polls: 20, eta: fixed({ A: 2000, B: 1820, C: 2100 }) })
    expect(log.switches).toEqual([{ nowSec: 60, from: 'A', to: 'B' }])
    expect(log.codes.slice(0, 2)).toEqual(['confirming', 'faster-route'])
    expect(log.polls[0]!.decision.reason).toBe('Staying: faster route saves 3 minutes, confirming, check 1 of 2')
    // 4.7 km before the turn-off, in words to speak.
    const switched = log.polls[1]!.decision
    expect(switched.reason).toBe('Switching: saves 3 minutes, turn in 2.9 miles')
    expect(switched.considered).toMatchObject({ savingSec: 180, requiredLeadM: 400, onFreeway: false })
    expect(switched.considered!.turnInM).toBeCloseTo(4700, 0)
    expect(switched.considered!.turnAt[0]).toBeCloseTo(at(5000, 0)[0], 6)
    // From then on the old route is the slower alternative, and once B is alone on its own road there is none.
    expect(new Set(log.codes.slice(2))).toEqual(new Set(['current-best', 'no-alternative']))
  })

  it('needs as many confirming polls as confirmPolls says', () => {
    const steady = { polls: 8, eta: fixed({ A: 2000, B: 1820 }) }
    expect(drive({ ...steady, options: { confirmPolls: 1 } }).switches.map((s) => s.nowSec)).toEqual([0])
    expect(drive({ ...steady, options: { confirmPolls: 4 } }).switches.map((s) => s.nowSec)).toEqual([180])
  })

  it('a gain that appears inside the lead distance is refused, and then the turn-off is behind', () => {
    const log = drive({
      startAlongM: 4000,
      polls: 8,
      // The gain shows up at the fourth poll, 100 m before the turn-off.
      eta: (name, { poll }) => (name === 'A' ? 2000 : name === 'B' ? (poll >= 3 ? 1700 : 2050) : name === 'C' ? 2100 : null),
    })
    expect(log.switches).toEqual([])
    expect(log.codes).toEqual(['current-best', 'current-best', 'current-best', 'too-late', 'current-best', 'current-best', 'current-best', 'current-best'])
    const refused = log.polls[3]!.decision
    expect(refused.reason).toBe('Staying: faster route turns off in 300 feet, too late to take safely')
    expect(refused.considered!.turnInM).toBeCloseTo(100, 0)
    expect(refused.considered!.requiredLeadM).toBe(400)
    // Past 5 km only C is still ahead.
    expect(log.polls[4]!.decision.nextState.pending).toBeNull()
  })

  it('a confirmed gain is still refused when the second poll comes too close to the turn-off', () => {
    const log = drive({
      startAlongM: 4050,
      polls: 5,
      eta: (name, { poll }) => (name === 'A' ? 2000 : name === 'B' ? (poll >= 1 ? 1700 : 2050) : null),
    })
    // 650 m ahead: confirming. 350 m and 50 m ahead: too late. Then B is behind and nothing is left.
    expect(log.codes).toEqual(['current-best', 'confirming', 'too-late', 'too-late', 'no-alternative'])
    expect(log.switches).toEqual([])
  })

  it('cooldown: a second, better route has to wait five minutes after a switch', () => {
    const log = drive({
      polls: 10,
      eta: (name, { poll }) => (name === 'A' ? 2000 : name === 'B' ? 1820 : name === 'D' && poll >= 2 ? 1500 : null),
    })
    expect(log.switches).toEqual([
      { nowSec: 60, from: 'A', to: 'B' },
      { nowSec: 360, from: 'B', to: 'D' },
    ])
    expect(log.codes).toEqual(['confirming', 'faster-route', 'confirming', 'cooldown', 'cooldown', 'cooldown', 'faster-route', 'current-best', 'current-best', 'current-best'])
    expect(log.polls[3]!.decision.reason).toBe('Staying: faster route saves 5.3 minutes, but we switched routes 2 minutes ago')
  })

  it('no return: the route just left needs twice the saving, until ten minutes have passed', () => {
    const log = drive({
      polls: 14,
      // After the switch to B, A comes back 150 s faster: enough for a new route, not for a return.
      eta: (name, { poll }) => (name === 'B' ? 1820 : name === 'A' ? (poll >= 2 ? 1670 : 2000) : null),
    })
    expect(log.switches).toEqual([
      { nowSec: 60, from: 'A', to: 'B' },
      { nowSec: 720, from: 'B', to: 'A' },
    ])
    // Refused from 120 s to 600 s, the cooldown having ended long before; free again at 660 s.
    expect(log.codes.slice(2, 11)).toEqual(Array.from({ length: 9 }, () => 'recently-abandoned'))
    expect(log.codes.slice(11, 13)).toEqual(['confirming', 'faster-route'])
    expect(log.polls[2]!.decision.reason).toBe(
      'Staying: faster route is the one we left 60 seconds ago, and it saves only 2.5 minutes',
    )
    expect(log.polls[11]!.stateBefore.abandoned).toHaveLength(1)
    expect(log.polls[11]!.decision.nextState.abandoned).toHaveLength(0)
  })

  it('no return: twice the saving does bring the old route back, after the cooldown', () => {
    const log = drive({
      polls: 9,
      eta: (name, { poll }) => (name === 'B' ? 1820 : name === 'A' ? (poll >= 2 ? 1500 : 2000) : null),
    })
    expect(log.switches).toEqual([
      { nowSec: 60, from: 'A', to: 'B' },
      { nowSec: 360, from: 'B', to: 'A' },
    ])
    expect(log.codes.slice(2, 7)).toEqual(['confirming', 'cooldown', 'cooldown', 'cooldown', 'faster-route'])
  })

  it('a third route that is not the one left is not held to the return rule', () => {
    // On B after the switch; C (off the main road farther on) is not offered from B, D is.
    const log = drive({
      polls: 9,
      options: { cooldownSec: 0 },
      eta: (name, { poll }) => (name === 'A' ? 2000 : name === 'B' ? 1820 : name === 'D' && poll >= 2 ? 1690 : null),
    })
    // 130 s saved: under the doubled minimum, over the plain one.
    expect(log.switches.map((s) => s.to)).toEqual(['B', 'D'])
  })

  it('no alternatives: stays, every poll', () => {
    const log = drive({ polls: 10, eta: fixed({ A: 2000 }) })
    expect(log.switches).toEqual([])
    expect(new Set(log.codes)).toEqual(new Set(['no-alternative']))
    expect(log.polls[0]!.decision.reason).toBe('Staying: no other route available right now')
  })

  it('an empty answer: stays', () => {
    const log = drive({ polls: 4, eta: fixed({ A: 2000, B: 1500 }), tamper: () => [] })
    expect(log.switches).toEqual([])
    expect(new Set(log.codes)).toEqual(new Set(['no-routes']))
  })

  it('failed polls change nothing but a counter, and a confirmation in progress survives them', () => {
    const log = drive({
      polls: 8,
      eta: fixed({ A: 2000, B: 1820 }),
      tamper: (candidates, { poll }) => (poll >= 1 && poll <= 5 ? null : candidates),
    })
    expect(log.codes).toEqual(['confirming', 'poll-failed', 'poll-failed', 'poll-failed', 'poll-failed', 'poll-failed', 'faster-route', 'current-best'])
    const afterFirst = log.polls[0]!.decision.nextState
    expect(afterFirst.pending?.polls).toBe(1)
    for (let failed = 1; failed <= 5; failed++) {
      expect(log.polls[failed]!.decision.nextState).toEqual({ ...afterFirst, failedPolls: failed })
      expect(log.polls[failed]!.decision.action).toBe('stay')
    }
    expect(log.polls[1]!.decision.reason).toBe('Staying: could not check for faster routes')
    expect(log.polls[3]!.decision.reason).toBe('Staying: could not check for faster routes, 3 tries in a row')
    expect(log.switches).toEqual([{ nowSec: 360, from: 'A', to: 'B' }])
    expect(log.polls[6]!.decision.nextState.failedPolls).toBe(0)
  })

  // The old rule here was "missing from the fresh routes three polls in a row: take the best
  // fresh route". On real drives that fired with nothing wrong (the provider returns three
  // routes at most, and the same road came back drawn a little differently), so a route that
  // is merely not offered is no longer a reason to switch: the next four tests replace it.
  it('current route not among the candidates and nothing else known: stays on it, however long', () => {
    const log = drive({
      polls: 12,
      eta: fixed({ A: 2000, B: 1900, C: 1950 }),
      tamper: (candidates, { poll }) => (poll >= 1 ? candidates.filter((c) => nameOf(c) !== 'A') : candidates),
    })
    expect(log.switches).toEqual([])
    expect(log.codes).toEqual(['saving-too-small', ...Array<string>(11).fill('route-unconfirmed')])
    expect(log.polls[1]!.decision.reason).toBe(
      'Staying: current route is not among the fresh routes, and its travel time could not be checked',
    )
    // Not being offered is not evidence against the road ahead: nothing counts up.
    expect(log.polls.map((p) => p.decision.nextState.lostPolls)).toEqual(Array<number>(12).fill(0))
    expect(log.polls[5]!.decision.current).toBeNull()
  })

  it('current route not among the candidates: its own travel time is asked for, and the usual rules decide', () => {
    // The provider only offers B and C. Asked for the main road itself it says 2000 s, and from the fourth poll 2300 s.
    const log = drive({
      polls: 6,
      eta: fixed({ B: 1900, C: 1950 }),
      baseline: (_, { poll, position }) => [candidate('A', position, poll >= 3 ? 2300 : 2000)!],
    })
    expect(log.codes).toEqual(['saving-too-small', 'saving-too-small', 'saving-too-small', 'confirming', 'faster-route', 'current-best'])
    expect(log.polls[0]!.decision.current).toMatchObject({ durationSec: 2000, asked: true })
    expect(log.polls[0]!.decision.reason).toBe('Staying: faster route saves only 1.6 minutes')
    // A real saving, measured like for like, confirmed over two polls: an ordinary switch.
    expect(log.polls[4]!.decision.reason).toBe('Switching: saves 6.6 minutes, turn in 2.3 miles')
    expect(log.polls[4]!.decision.considered!.savingSec).toBe(400)
    expect(log.switches).toEqual([{ nowSec: 240, from: 'A', to: 'B' }])
    expect(log.polls.every((p) => p.decision.nextState.lostPolls === 0)).toBe(true)
  })

  it('asked for the road ahead three times and no route found that way: takes the best fresh route, and says why', () => {
    const log = drive({
      polls: 6,
      eta: fixed({ A: 2000, B: 1900, C: 1950 }),
      tamper: (candidates, { poll }) => (poll >= 1 ? candidates.filter((c) => nameOf(c) !== 'A') : candidates),
      // Asked for the main road itself, the provider finds no route along it.
      baseline: (_, { poll }) => (poll >= 1 ? [] : null),
    })
    expect(log.codes.slice(0, 4)).toEqual(['saving-too-small', 'route-unconfirmed', 'route-unconfirmed', 'route-lost'])
    expect(log.polls[1]!.decision.reason).toBe('Staying: the road ahead could not be routed, check 1 of 3')
    expect(log.polls[3]!.decision.reason).toBe('Switching: the road ahead can no longer be routed, turn in 2.5 miles')
    expect(log.polls[3]!.decision.considered!.savingSec).toBeNull()
    expect(log.switches).toEqual([{ nowSec: 180, from: 'A', to: 'B' }])
  })

  it('the road ahead cannot be routed: the route left a moment ago may be the one to take', () => {
    // On B since the switch at 60 s. Then the provider stops offering B, puts A first, and
    // finds no route when asked for B itself.
    const log = drive({
      polls: 9,
      eta: (name, { poll }) => (name === 'A' ? (poll >= 2 ? 1700 : 2000) : name === 'B' ? 1820 : name === 'C' ? 1900 : null),
      tamper: (candidates, { poll }) => (poll >= 2 ? candidates.filter((c) => nameOf(c) !== 'B') : candidates),
      baseline: (_, { poll }) => (poll >= 2 ? [] : null),
    })
    expect(log.codes.slice(0, 8)).toEqual([
      'confirming',
      'faster-route',
      'route-unconfirmed',
      'route-unconfirmed',
      // Three such answers, but the cooldown (until 360 s) still holds.
      'cooldown',
      'cooldown',
      'route-lost',
      'current-best',
    ])
    expect(log.switches).toEqual([
      { nowSec: 60, from: 'A', to: 'B' },
      { nowSec: 360, from: 'B', to: 'A' },
    ])
    expect(log.polls[4]!.decision.reason).toBe(
      'Staying: switched routes 3 minutes ago, and the road ahead can no longer be routed',
    )
  })

  it('forgives a position reported a little further on than where the routes were fetched from', () => {
    const route = candidate('A', at(0, 0), 2000)!
    const fetchedFrom = at(3000, 0)
    const poll = (positionAlongM: number) =>
      decideReroute(INITIAL_REROUTE_STATE, {
        nowSec: 0,
        route,
        positionAlongM,
        speedMps: 15,
        candidates: [candidate('A', fetchedFrom, 1700)!, candidate('B', fetchedFrom, 1800)!],
      })
    expect(poll(3000).code).toBe('current-best')
    // 40 m on (a second or two of driving): still the same route.
    expect(poll(3040).code).toBe('current-best')
    // 300 m on, the answer is stale. The old matcher (every vertex within 10 m, starts together)
    // called that "current route missing" and counted towards leaving it, which was the bug:
    // routes that start a little behind the car are still the same routes, compared like for like.
    expect(poll(3300)).toMatchObject({ action: 'stay', code: 'current-best' })
    // Only a straight approach from behind is left out of the comparison: a route that first
    // drives a kilometer the other way and turns back is not the current route (#41 review).
    const uTurn = (yM: number) => {
      const geometry = [at(2900, 0), at(1900, 0), at(1900, yM), at(20000, yM)]
      return { ...candidate('A', fetchedFrom, 1700)!, id: `u-turn-${yM}`, geometry, distanceM: alongRouteM(geometry).at(-1)!, maneuvers: [] }
    }
    expect(findCurrentRoute(route, 3000, [uTurn(15)])).toBeNull()
    expect(findCurrentRoute(route, 3000, [uTurn(0.1)])).toBeNull()
  })

  it('the road ahead not routed for one poll only: the count starts again', () => {
    const log = drive({
      polls: 8,
      eta: fixed({ A: 2000, B: 1900 }),
      tamper: (candidates, { poll }) => (poll % 3 === 1 ? candidates.filter((c) => nameOf(c) !== 'A') : candidates),
      baseline: (_, { poll }) => (poll % 3 === 1 ? [] : null),
    })
    expect(log.switches).toEqual([])
    expect(log.codes).toEqual(['saving-too-small', 'route-unconfirmed', 'saving-too-small', 'saving-too-small', 'route-unconfirmed', 'saving-too-small', 'saving-too-small', 'route-unconfirmed'])
    expect(log.polls.map((p) => p.decision.nextState.lostPolls)).toEqual([0, 1, 0, 0, 1, 0, 0, 1])
  })

  it('"no route" answers add up even with "another road" answers between them; finding the current route starts over (#41)', () => {
    // A closure between via points: some checks the points miss it and the provider routes round it
    // through them (another road), some checks a point lands on it (no route).
    const lostAt = (poll: number) => poll % 2 === 0
    const log = drive({
      polls: 5,
      eta: fixed({ A: 2000, B: 1900 }),
      tamper: (candidates) => candidates.filter((c) => nameOf(c) !== 'A'),
      baseline: (candidates, { poll }) => (lostAt(poll) ? [] : candidates.filter((c) => nameOf(c) === 'B')),
    })
    expect(log.polls.map((p) => p.decision.nextState.lostPolls)).toEqual([1, 1, 2, 2, 0])
    expect(log.codes).toEqual(['route-unconfirmed', 'route-unconfirmed', 'route-unconfirmed', 'route-unconfirmed', 'route-lost'])
    expect(log.switches).toHaveLength(1)
    // The current route offered again between them: the count starts over, and nothing switches.
    const found = drive({
      polls: 5,
      eta: fixed({ A: 2000, B: 1900 }),
      tamper: (candidates, { poll }) => (poll === 3 ? candidates : candidates.filter((c) => nameOf(c) !== 'A')),
      baseline: (candidates, { poll }) => (poll === 3 ? null : lostAt(poll) ? [] : candidates.filter((c) => nameOf(c) === 'B')),
    })
    expect(found.polls.map((p) => p.decision.nextState.lostPolls)).toEqual([1, 1, 2, 0, 1])
    expect(found.switches).toEqual([])
  })

  it('"no route" answers older than routeLostWindowSec no longer count toward leaving the route (#68)', () => {
    // One "no route" answer at the start, then a quarter of an hour of "another road" answers
    // (no evidence either way), then two more "no route" answers. The first is 17 minutes old
    // by then: three in all, but only two recent ones, so no switch until a third recent one.
    const noRouteAt = (poll: number) => poll === 0 || poll >= 16
    const script = {
      polls: 19,
      speedMps: 1,
      eta: fixed({ A: 2000, B: 1900 }),
      tamper: (candidates: RouteCandidate[]) => candidates.filter((c) => nameOf(c) !== 'A'),
      baseline: (candidates: readonly RouteCandidate[], { poll }: PollContext) =>
        noRouteAt(poll) ? [] : candidates.filter((c) => nameOf(c) === 'B'),
    }
    const log = drive(script)
    const counts = log.polls.map((p) => p.decision.nextState.lostPolls)
    expect(counts.slice(0, 2)).toEqual([1, 1])
    // 900 s after the first answer it still counts; at 960 s it has dropped out.
    expect(counts[15]).toBe(1)
    // The third recent answer switches (and a switch starts the count over).
    expect(counts.slice(16)).toEqual([1, 2, 0])
    expect(log.codes[18]).toBe('route-lost')
    expect(log.switches).toEqual([{ nowSec: 18 * 60, from: 'A', to: 'B' }])
    expect(log.polls[17]!.decision.reason).toBe('Staying: the road ahead could not be routed, check 2 of 3')
    // Without the window (as before #68) the stale answer counted and the switch came a poll sooner.
    const unbounded = drive({ ...script, options: { routeLostWindowSec: 1e9 } })
    expect(unbounded.switches).toEqual([{ nowSec: 17 * 60, from: 'A', to: 'B' }])
    // The window only ever takes answers away: three recent ones in a row still switch at once.
    const recent = drive({ ...script, baseline: () => [] })
    expect(recent.switches).toEqual([{ nowSec: 2 * 60, from: 'A', to: 'B' }])
  })

  it('a poll that could not ask for the current path neither adds to the count nor clears it', () => {
    const state: RerouteState = { ...INITIAL_REROUTE_STATE, lostPolls: 2, lostAtSec: [0, 0] }
    const notAsked = pollOnA({ xM: 1000, etas: { B: 1500 }, state })
    expect(notAsked).toMatchObject({ action: 'stay', code: 'route-unconfirmed' })
    expect(notAsked.nextState.lostPolls).toBe(2)
    // "No route through these points" is the answer that counts: the third in a row.
    expect(pollOnA({ xM: 1000, etas: { B: 1500 }, state, baseline: {} })).toMatchObject({ action: 'switch', code: 'route-lost' })
    // Answered with another road (the via points did not pin the path): no evidence either way,
    // and the count is kept (#41). It used to start again, so a closure between two via points
    // never added up.
    const otherRoad = pollOnA({ xM: 1000, etas: { B: 1500 }, state, baseline: { B: 1500 } })
    expect(otherRoad).toMatchObject({ action: 'stay', code: 'route-unconfirmed' })
    expect(otherRoad.reason).toBe('Staying: current route is not among the fresh routes, and asking for it brought back another road')
    expect(otherRoad.nextState.lostPolls).toBe(2)
    // An answer that is the current path but has no typical duration is not compared, and is not shown as its ETA.
    const noTraffic = pollOnA({ xM: 1000, etas: { B: 1500 }, baseline: { A: 2400 }, extra: { A: { typicalDurationSec: null } } })
    expect(noTraffic).toMatchObject({ action: 'stay', code: 'no-traffic-data', current: null })
  })

  it('the road ahead cannot be routed and the only other route turns off too soon: stays', () => {
    const lost = pollOnA({ xM: 4700, etas: { B: 1500 }, baseline: {}, options: { routeLostPolls: 1 } })
    expect(lost).toMatchObject({ action: 'stay', code: 'too-late' })
    expect(lost.reason).toBe(
      'Staying: the road ahead can no longer be routed, but the other route turns off in 0.1 miles, too late to take safely',
    )
    // Inside the cooldown it waits as well.
    const cooling = pollOnA({
      xM: 1000,
      nowSec: 100,
      etas: { B: 1500 },
      baseline: {},
      options: { routeLostPolls: 1 },
      state: { ...INITIAL_REROUTE_STATE, lastSwitchAtSec: 0 },
    })
    expect(cooling).toMatchObject({ action: 'stay', code: 'cooldown' })
    expect(pollOnA({ xM: 1000, etas: { B: 1500 }, baseline: {}, options: { routeLostPolls: 1 } })).toMatchObject({
      action: 'switch',
      code: 'route-lost',
    })
    // Without the answer to that request there is no switch, whatever routeLostPolls says.
    expect(pollOnA({ xM: 1000, etas: { B: 1500 }, options: { routeLostPolls: 1 } })).toMatchObject({
      action: 'stay',
      code: 'route-unconfirmed',
    })
  })

  it('off route: takes the best fresh route at once, cooldown or not', () => {
    const offRoad = (id: string, durationSec: number): RouteCandidate => ({
      ...candidate('A', at(3000, 0), durationSec)!,
      id,
      geometry: [at(3000, 200), at(3400, 200), at(20000, 0)],
    })
    const decision = decideReroute(
      { ...INITIAL_REROUTE_STATE, lastSwitchAtSec: 990 },
      {
        nowSec: 1000,
        route: candidate('A', at(0, 0), 2000)!,
        positionAlongM: 3000,
        speedMps: 10,
        candidates: [offRoad('slow', 1900), offRoad('fast', 1700)],
      },
    )
    expect(decision).toMatchObject({ action: 'switch', code: 'off-route', toRouteId: 'fast' })
    expect(decision.reason).toBe('Switching: off the planned route, taking the fastest route from here')
    expect(decision.nextState.lastSwitchAtSec).toBe(1000)
    // The caller's own measurement (GPS) wins over where the fresh routes start.
    const measured = decideReroute(
      INITIAL_REROUTE_STATE,
      {
        nowSec: 0,
        route: candidate('A', at(0, 0), 2000)!,
        positionAlongM: 3000,
        speedMps: 10,
        candidates: [candidate('A', at(3000, 0), 1700)!],
        offRouteM: 80,
      },
    )
    expect(measured.code).toBe('off-route')
  })
})

describe('missing data', () => {
  it('no typical (traffic) duration on the current route: stays', () => {
    const decision = pollOnA({ xM: 1000, etas: { A: 2000, B: 1500 }, extra: { A: { typicalDurationSec: null } }, options: NO_CONFIRM })
    expect(decision).toMatchObject({ action: 'stay', code: 'no-traffic-data' })
    expect(decision.reason).toBe('Staying: no traffic data for the current route')
  })

  it('no typical duration on the alternative: it is passed over', () => {
    const decision = pollOnA({ xM: 1000, etas: { A: 2000, B: 1500 }, extra: { B: { typicalDurationSec: null } }, options: NO_CONFIRM })
    expect(decision).toMatchObject({ action: 'stay', code: 'no-traffic-data' })
    // Another alternative with full data is still considered.
    const other = pollOnA({ xM: 1000, etas: { A: 2000, B: 1500, C: 1800 }, extra: { B: { typicalDurationSec: null } }, options: NO_CONFIRM })
    expect(other.action).toBe('switch')
    expect(nameOf({ id: other.toRouteId! })).toBe('C')
  })

  it('compares without typical durations only when told to', () => {
    const decision = pollOnA({
      xM: 1000,
      etas: { A: 2000, B: 1500 },
      extra: { A: { typicalDurationSec: null }, B: { typicalDurationSec: null } },
      options: { ...NO_CONFIRM, requireTypicalDuration: false },
    })
    expect(decision.action).toBe('switch')
  })

  it('no travel time at all: stays', () => {
    const current = pollOnA({ xM: 1000, etas: { A: 2000, B: 1500 }, extra: { A: { durationSec: NaN } }, options: NO_CONFIRM })
    expect(current).toMatchObject({ action: 'stay', code: 'no-eta' })
    const other = pollOnA({ xM: 1000, etas: { A: 2000, B: 1500 }, extra: { B: { durationSec: NaN } }, options: NO_CONFIRM })
    expect(other).toMatchObject({ action: 'stay', code: 'no-traffic-data' })
  })

  it('candidates without a line to drive are ignored', () => {
    const decision = pollOnA({ xM: 1000, etas: { A: 2000, B: 1500 }, extra: { A: { geometry: [] }, B: { geometry: [at(1000, 0)] } } })
    expect(decision).toMatchObject({ action: 'stay', code: 'no-routes' })
  })
})

describe('minimum saving', () => {
  it('120 seconds is the floor, to the second', () => {
    expect(pollOnA({ xM: 1000, etas: { A: 2000, B: 1880.5 }, options: NO_CONFIRM }).code).toBe('saving-too-small')
    expect(pollOnA({ xM: 1000, etas: { A: 2000, B: 1880 }, options: NO_CONFIRM }).action).toBe('switch')
    expect(pollOnA({ xM: 1000, etas: { A: 2000, B: 1960 }, options: NO_CONFIRM }).reason).toBe(
      'Staying: faster route saves only 40 seconds',
    )
  })

  it('a long leg: 2.5 minutes on 90 is under 5% and not worth it', () => {
    const long = pollOnA({ xM: 1000, etas: { A: 5400, B: 5250 }, options: NO_CONFIRM })
    expect(long).toMatchObject({ action: 'stay', code: 'saving-share-too-small' })
    expect(long.reason).toBe('Staying: faster route saves only 2.5 minutes of the remaining 90 minutes')
    expect(pollOnA({ xM: 1000, etas: { A: 5400, B: 5130 }, options: NO_CONFIRM }).action).toBe('switch')
  })

  it('a tiny remaining trip: a third of the time saved is still only a minute', () => {
    const tiny = pollOnA({ xM: 17500, etas: { A: 200, E: 140 }, options: NO_CONFIRM })
    expect(tiny).toMatchObject({ action: 'stay', code: 'saving-too-small' })
    expect(tiny.reason).toBe('Staying: faster route saves only 60 seconds')
    // And a real gain near the end is no use when the turn is 300 m away.
    const close = pollOnA({ xM: 18200, etas: { A: 400, E: 250 }, options: NO_CONFIRM })
    expect(close).toMatchObject({ action: 'stay', code: 'too-late' })
  })
})

describe('too-late maneuver guard', () => {
  it('asks for 20 seconds of driving when that is more than 400 m', () => {
    const slow = pollOnA({ xM: 4400, etas: { A: 2000, B: 1700 }, speedMps: 10, options: NO_CONFIRM })
    expect(slow.action).toBe('switch')
    expect(slow.considered!.requiredLeadM).toBe(400)
    const fast = pollOnA({ xM: 4400, etas: { A: 2000, B: 1700 }, speedMps: 35, options: NO_CONFIRM })
    expect(fast).toMatchObject({ action: 'stay', code: 'too-late' })
    expect(fast.considered!.requiredLeadM).toBe(700)
    expect(fast.considered!.turnInM).toBeCloseTo(600, 0)
  })

  it('freeway: the exit has to be 1200 m ahead', () => {
    // B leaves the main road 800 m ahead, and the road up to there is freeway.
    const onFreeway = pollOnA({ xM: 4200, etas: { A: 2000, B: 1700 }, extra: { B: { limitedAccessSpansM: [[0, 800]] } }, options: NO_CONFIRM })
    expect(onFreeway).toMatchObject({ action: 'stay', code: 'too-late' })
    expect(onFreeway.considered).toMatchObject({ onFreeway: true, requiredLeadM: 1200 })
    expect(onFreeway.reason).toBe('Staying: faster route turns off in 0.4 miles, too late to take safely')
    // The same turn from a street is fine.
    const onStreet = pollOnA({ xM: 4200, etas: { A: 2000, B: 1700 }, extra: { B: { limitedAccessSpansM: [] } }, options: NO_CONFIRM })
    expect(onStreet.action).toBe('switch')
    // Freeway that ends before the turn-off does not count.
    const leftIt = pollOnA({ xM: 4200, etas: { A: 2000, B: 1700 }, extra: { B: { limitedAccessSpansM: [[0, 300]] } }, options: NO_CONFIRM })
    expect(leftIt.action).toBe('switch')
    // With room to spare the exit is taken.
    const early = pollOnA({ xM: 3700, etas: { A: 2000, B: 1700 }, extra: { B: { limitedAccessSpansM: [[0, 1300]] } }, options: NO_CONFIRM })
    expect(early.action).toBe('switch')
    expect(early.considered).toMatchObject({ onFreeway: true, requiredLeadM: 1200 })
  })

  it('freeway: falls back on the current route when the alternative does not say what road it is', () => {
    const decision = pollOnA({
      xM: 4200,
      etas: { A: 2000, B: 1700 },
      extra: { A: { limitedAccessSpansM: [[0, 15800]] }, B: { limitedAccessSpansM: null } },
      options: NO_CONFIRM,
    })
    expect(decision).toMatchObject({ action: 'stay', code: 'too-late' })
    expect(decision.considered!.onFreeway).toBe(true)
  })

  it('uses the first maneuver of its own when that comes before the lines part', () => {
    // An exit lane that runs beside the main road: the lines only part 1000 m ahead, the exit is at 300 m.
    const here = at(4000, 0)
    const exit = { atDistanceM: 300, kind: 'off ramp right', location: at(4300, 0) }
    const withExit = (c: RouteCandidate): RouteCandidate => ({ ...c, maneuvers: [c.maneuvers[0]!, exit, ...c.maneuvers.slice(1)] })
    const poll = (current: RouteCandidate) =>
      decideReroute(
        INITIAL_REROUTE_STATE,
        {
          nowSec: 0,
          route: candidate('A', at(0, 0), 2000)!,
          positionAlongM: 4000,
          speedMps: 5,
          candidates: [current, withExit(candidate('B', here, 1700)!)],
        },
        NO_CONFIRM,
      )
    const refused = poll(candidate('A', here, 2000)!)
    expect(refused).toMatchObject({ action: 'stay', code: 'too-late' })
    expect(refused.considered!.turnInM).toBe(300)
    expect(refused.considered!.turnAt).toEqual(at(4300, 0))
    // A maneuver the current route makes too is not the alternative's own.
    const shared = poll(withExit(candidate('A', here, 2000)!))
    expect(shared.action).toBe('switch')
    expect(shared.considered!.turnInM).toBeCloseTo(1000, 0)
  })

  it('refuses an alternative that leaves the route right where the driver is', () => {
    const decision = pollOnA({ xM: 5000, etas: { A: 2000, B: 1500 }, options: NO_CONFIRM })
    expect(decision).toMatchObject({ action: 'stay', code: 'too-late' })
    expect(decision.considered!.turnInM).toBe(0)
    expect(decision.reason).toBe('Staying: faster route turns off in 0 feet, too late to take safely')
  })
})

describe('signals never decide a switch on their own', () => {
  const signals = (signalCount: number, signalCoverage: RouteCandidate['signalCoverage'] = 'full') => ({ signalCount, signalCoverage })

  it('fewer signals with an equal or nearly equal ETA is not worth a change', () => {
    const equal = pollOnA({ xM: 1000, etas: { A: 2000, B: 2000 }, extra: { A: signals(20), B: signals(2) }, options: NO_CONFIRM })
    expect(equal).toMatchObject({ action: 'stay', code: 'current-best' })
    const close = pollOnA({ xM: 1000, etas: { A: 2000, B: 1990 }, extra: { A: signals(20), B: signals(2) }, options: NO_CONFIRM })
    expect(close).toMatchObject({ action: 'stay', code: 'saving-too-small' })
    const log = drive({
      polls: 14,
      eta: fixed({ A: 2000, B: 1990 }),
      tamper: (candidates) => candidates.map((c) => ({ ...c, ...signals(nameOf(c) === 'A' ? 20 : 2) })),
    })
    expect(log.switches).toEqual([])
  })

  it('between alternatives that both save enough, the existing ranking picks: ETA ties go to fewer signals', () => {
    const etas = { A: 2000, B: 1850, C: 1870 }
    const fewerOnC = pollOnA({ xM: 1000, etas, extra: { B: signals(20), C: signals(5) }, options: NO_CONFIRM })
    expect(nameOf({ id: fewerOnC.toRouteId! })).toBe('C')
    // A partial count is unknown to the ranking, so the faster one is taken.
    const partial = pollOnA({ xM: 1000, etas, extra: { B: signals(20), C: signals(5, 'partial') }, options: NO_CONFIRM })
    expect(nameOf({ id: partial.toRouteId! })).toBe('B')
    // Outside the 30 s tie window signals have no say.
    const clear = pollOnA({ xM: 1000, etas: { A: 2000, B: 1800, C: 1870 }, extra: { B: signals(20), C: signals(5) }, options: NO_CONFIRM })
    expect(nameOf({ id: clear.toRouteId! })).toBe('B')
  })

  it('duplicate signals and partial coverage do not change a decision the ETA has made', () => {
    const script: DriveScript = { polls: 12, eta: fixed({ A: 2000, B: 1820, C: 2100 }) }
    const plain = drive(script)
    const outline = (log: ReturnType<typeof drive>) => log.polls.map((p) => [p.decision.action, p.decision.code, p.decision.reason])
    const decorations: ((name: RouteName, context: PollContext) => Partial<RouteCandidate>)[] = [
      // Every signal counted twice on the faster route.
      (name) => signals(name === 'B' ? 48 : 24),
      // Coverage comes and goes from poll to poll.
      (name, { poll }) => signals(name === 'B' ? 30 : 3, poll % 2 === 0 ? 'partial' : 'full'),
      (name) => (name === 'A' ? signals(0) : { signalCount: null, signalCoverage: 'none' }),
      (_, { poll }) => signals(poll, 'partial'),
    ]
    for (const decorate of decorations) {
      const decorated = drive({ ...script, tamper: (candidates, context) => candidates.map((c) => ({ ...c, ...decorate(nameOf(c), context) })) })
      expect(outline(decorated)).toEqual(outline(plain))
      expect(decorated.switches).toEqual(plain.switches)
    }
  })
})

/** A small seeded generator (mulberry32), so the "random" drives are the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('determinism', () => {
  const script: DriveScript = {
    polls: 14,
    eta: (name, { poll }) => (name === 'B' ? 1820 : name === 'A' ? (poll >= 2 ? 1500 : 2000) : name === 'C' ? 1900 : null),
  }
  // Route ids are new on every poll by design, so they are left out of the comparison.
  const outline = (log: ReturnType<typeof drive>) =>
    log.polls.map(({ nowSec, on, decision }) => ({
      nowSec,
      on,
      action: decision.action,
      code: decision.code,
      reason: decision.reason,
      nextState: decision.nextState,
      turnInM: decision.considered?.turnInM,
    }))

  it('the same drive gives the same decisions, reasons and states', () => {
    expect(outline(drive(script))).toEqual(outline(drive(script)))
  })

  it('the same call gives the same answer and leaves its inputs alone', () => {
    const freeze = <T>(value: T): T => {
      if (typeof value === 'object' && value !== null) {
        Object.values(value).forEach(freeze)
        Object.freeze(value)
      }
      return value
    }
    const here = at(1000, 0)
    const state = freeze({
      ...INITIAL_REROUTE_STATE,
      pending: { geometry: candidate('B', at(700, 0), 1800)!.geometry, polls: 1 },
      abandoned: [{ geometry: candidate('C', at(0, 0), 1800)!.geometry, atSec: -100 }],
    })
    const observation = freeze({
      nowSec: 60,
      route: candidate('A', at(0, 0), 2000)!,
      positionAlongM: 1000,
      speedMps: 12,
      candidates: [candidate('A', here, 2000)!, candidate('B', here, 1800)!, candidate('C', here, 1900)!],
    })
    const first = decideReroute(state, observation)
    const second = decideReroute(state, observation)
    expect(first).toEqual(second)
    expect(first.action).toBe('switch')
    // The order the candidates arrive in does not matter either.
    const reversed = decideReroute(state, { ...observation, candidates: [...observation.candidates].reverse() })
    expect(reversed).toEqual(first)
  })
})

describe('a match looked up is the match worked out (#96)', () => {
  // A check matches its fresh routes against the road ahead in baselineProbe and again in
  // decideReroute; the second time the answer is looked up, by the two geometry arrays, where
  // the road ahead was cut and the thresholds. These drives keep the same arrays from poll to
  // poll while the route being driven, the car's position and the thresholds change, so that
  // the same fresh line is the current route in one poll and not in the next: an answer
  // looked up under the wrong key shows here. The other side gets new copies of every line,
  // which nothing has matched before, so everything is worked out afresh.
  const copyLine = (line: readonly LngLat[]): LngLat[] => line.map(([lng, lat]) => [lng, lat])
  const copyAll = (routes: readonly RouteCandidate[]) => routes.map((c) => ({ ...c, geometry: copyLine(c.geometry) }))
  /** The same route drawn `northM` meters north of where it is: another drawing of the same road. */
  const drawnNorth = (c: RouteCandidate, northM: number): RouteCandidate => ({
    ...c,
    geometry: c.geometry.map(([lng, lat]) => [lng, lat + northM / 111_195]),
  })
  const driven = (['A', 'B'] as const).map((name) => ({ geometry: candidate(name, at(0, 0), 2000)!.geometry, maneuvers: [], limitedAccessSpansM: null }))
  // Meters along the route being driven: where the fresh routes start, just behind and just
  // past it, and 3 km on (past where B leaves A, so the fresh B is not the rest of B from there).
  const POSITIONS = [3950, 4000, 4050, 7000]
  const THRESHOLDS: Partial<RerouteOptions>[] = [{}, { matchToleranceM: 5 }, { matchToleranceM: 40, matchMaxGapM: 60 }, { offRouteM: 15 }]

  it('gives the same answers, reasons and states over 12 seeded drives', () => {
    const outcomes = new Set<string>()
    for (let seed = 1; seed <= 12; seed++) {
      const random = seeded(seed)
      const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!
      // Fresh routes from 4 km along A (before B and D leave it), kept for the whole drive: A
      // drawn on the line, A drawn 12 m off it (the same road only with a tolerance above 12 m), B, C and D.
      const from = at(4000, 0)
      const routes = (['A', 'B', 'C', 'D'] as const).map((name) => candidate(name, from, 1000)!)
      const pool = [drawnNorth(routes[0]!, 12), ...routes]
      let looked = INITIAL_REROUTE_STATE
      let fresh = INITIAL_REROUTE_STATE
      for (let poll = 0; poll < 10; poll++) {
        const route = pick(driven)
        const positionAlongM = pick(POSITIONS)
        // Switches on the first winning poll, so that the drives reach switches too.
        const options = { ...pick(THRESHOLDS), confirmPolls: 1 }
        // Now and then the A drawn on the line is left out, so only the other drawing can match.
        const candidates = pool
          .filter((_, i) => (i === 1 ? random() < 0.5 : random() < 0.85))
          .map((c) => ({ ...c, durationSec: Math.round(700 + random() * 600), typicalDurationSec: 900 }))
        const baseline = random() < 0.3 ? [pool[0]!] : undefined
        const observation = (cs: readonly RouteCandidate[], base: readonly RouteCandidate[] | undefined, line: readonly LngLat[]) => ({
          nowSec: poll * 60,
          route: { ...route, geometry: line },
          positionAlongM,
          speedMps: 12,
          candidates: cs,
          baseline: base,
        })

        // As a check does it: the path check first, on the same arrays the decision then gets.
        const probe = baselineProbe(route, positionAlongM, candidates, options)
        const current = findCurrentRoute(route, positionAlongM, candidates, options)
        const decided = decideReroute(looked, observation(candidates, baseline, route.geometry), options)
        // Afresh, on lines nobody has matched.
        expect(probe).toEqual(baselineProbe({ geometry: copyLine(route.geometry) }, positionAlongM, copyAll(candidates), options))
        const again = findCurrentRoute({ geometry: copyLine(route.geometry) }, positionAlongM, copyAll(candidates), options)
        expect(current?.id ?? null).toBe(again?.id ?? null)
        const afresh = decideReroute(fresh, observation(copyAll(candidates), baseline && copyAll(baseline), copyLine(route.geometry)), options)
        expect(decided).toEqual(afresh)
        looked = decided.nextState
        fresh = afresh.nextState
        outcomes.add(decided.action === 'switch' ? 'switch' : current === null ? 'not found' : 'found')
      }
    }
    // The drives reach every kind of answer, so each is compared.
    expect([...outcomes].sort()).toEqual(['found', 'not found', 'switch'])
  })
})

describe('property: seeded random ETAs', () => {
  const runs = Array.from({ length: 40 }, (_, i) => i + 1).map((seed) => {
    const random = seeded(seed)
    const options: Partial<RerouteOptions> = { confirmPolls: seed % 2 === 0 ? 1 : 2, noReturnSec: seed % 3 === 0 ? 0 : 600 }
    return { seed, options, log: drive({ polls: 62, options, eta: () => Math.round(1400 + random() * 1200) }) }
  })

  it('switches never come closer together than the cooldown', () => {
    let switches = 0
    for (const { seed, log } of runs) {
      switches += log.switches.length
      log.switches.forEach((s, i) => {
        if (i > 0) expect(s.nowSec - log.switches[i - 1]!.nowSec, `seed ${seed}`).toBeGreaterThanOrEqual(DEFAULT_REROUTE_OPTIONS.cooldownSec)
      })
    }
    // The check means something only if the random drives do switch.
    expect(switches).toBeGreaterThan(40)
  })

  it('every switch saved enough, with room to make the turn, and says so in one short sentence', () => {
    for (const { seed, log } of runs) {
      for (const { decision } of log.polls) {
        expect(decision.reason, `seed ${seed}`).toMatch(/^(Staying|Switching): \S/)
        expect(decision.reason.length).toBeLessThan(120)
        expect(decision.toRouteId === undefined).toBe(decision.action === 'stay')
        if (decision.action !== 'switch') continue
        expect(decision.code).toBe('faster-route')
        expect(decision.considered!.savingSec).toBeGreaterThanOrEqual(DEFAULT_REROUTE_OPTIONS.minSavingSec)
        expect(decision.considered!.turnInM).toBeGreaterThanOrEqual(decision.considered!.requiredLeadM)
        expect(decision.nextState.pending).toBeNull()
      }
    }
  })

  it('with the defaults, a route left is not taken again within ten minutes for less than twice the minimum', () => {
    for (const { seed, options, log } of runs) {
      if (options.noReturnSec === 0) continue
      log.switches.forEach((s, i) => {
        const back = log.switches.slice(0, i).find((earlier) => earlier.from === s.to && s.nowSec - earlier.nowSec < 600)
        if (back === undefined) return
        const decision = log.polls.find((p) => p.nowSec === s.nowSec)!.decision
        expect(decision.considered!.savingSec, `seed ${seed}`).toBeGreaterThanOrEqual(240)
      })
    }
  })
})

describe('a route the driver turned down', () => {
  // "Keep previous route" in the live drive: declineRoute, then the same faster route at every poll.
  const mainRoad = { geometry: candidate('A', at(0, 0), 2000)!.geometry, maneuvers: [], limitedAccessSpansM: null }
  const offer = (nowSec: number, state: RerouteState, xM: number) =>
    decideReroute(state, {
      nowSec,
      route: mainRoad,
      positionAlongM: xM,
      speedMps: 5,
      candidates: [candidate('A', at(xM, 0), 2000)!, candidate('B', at(xM, 0), 1500)!],
    })

  it('is not switched to again until its time is up, whatever it saves', () => {
    const b = candidate('B', at(900, 0), 1500)!
    const declined = declineRoute(INITIAL_REROUTE_STATE, b.geometry, 600)
    expect(declined).toEqual({ ...INITIAL_REROUTE_STATE, declined: [{ geometry: b.geometry, untilSec: 600 }] })
    const first = offer(60, declined, 1200)
    expect(first).toMatchObject({ action: 'stay', code: 'driver-declined' })
    expect(first.reason).toBe('Staying: faster route saves 8.3 minutes, but you chose to keep this route')
    // No confirmation builds up meanwhile.
    expect(first.nextState.pending).toBeNull()
    const second = offer(120, first.nextState, 1500)
    expect(second.code).toBe('driver-declined')
    // Once the time is up the entry is dropped and the usual rules apply again.
    const later = offer(600, second.nextState, 3000)
    expect(later.nextState.declined).toEqual([])
    expect(later).toMatchObject({ action: 'stay', code: 'confirming' })
    expect(offer(660, later.nextState, 3300)).toMatchObject({ action: 'switch', code: 'faster-route' })
  })

  it('another faster route is still taken', () => {
    const c = candidate('C', at(900, 0), 1500)!
    const first = offer(60, declineRoute(INITIAL_REROUTE_STATE, c.geometry, 600), 1200)
    expect(first.code).toBe('confirming')
    expect(offer(120, first.nextState, 1500)).toMatchObject({ action: 'switch', code: 'faster-route' })
  })

  it('drops a route-lost count in progress, so a lost road needs the full count again (#28)', () => {
    const b = candidate('B', at(900, 0), 1500)!
    const declined = declineRoute({ ...INITIAL_REROUTE_STATE, lostPolls: 2 }, b.geometry, 600)
    expect(declined.lostPolls).toBe(0)
    expect(declined.pending).toBeNull()
  })
})

// #51: the overlap matching walked every 10 m of both lines, and every point of a stretch apart
// looked at the whole other line, so a 100 km route cost about 12 times the old vertex-by-vertex
// matcher. The cost is counted (segment distance checks plus grid entries, see MatchMeter), not
// timed, so the test says the same on every machine.
describe('matching cost on a long route (#51)', () => {
  type Corner = readonly [xM: number, yM: number]
  /** Through the corners with a vertex every 20 m: 100 km is 5000 vertices. */
  const dense = (corners: readonly Corner[]): Corner[] => {
    const out: Corner[] = [corners[0]!]
    for (let i = 1; i < corners.length; i++) {
      const [x0, y0] = corners[i - 1]!
      const [x1, y1] = corners[i]!
      const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 20))
      for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n])
    }
    return out
  }
  /** A route north (+) or south (-) of the straight line by `bumpM` for the middle 45 %, as meters and as a candidate. */
  const bumped = (id: string, bumpM: number, durationSec: number) => {
    const xy = dense([[0, 0], [27_500, 0], [27_500, bumpM], [72_500, bumpM], [72_500, 0], [100_000, 0]])
    const geometry = xy.map(([x, y]) => at(x, y))
    const route: RouteCandidate = { ...candidate('A', at(0, 0), durationSec)!, id, geometry, distanceM: alongRouteM(geometry).at(-1)!, maneuvers: [] }
    return { xy, route }
  }
  // The current route: 100 km east, 1 km north for the middle 45 %. Three alternatives run 2 to
  // 4 km from it for that 45 % (the first just as long, so no length check rules it out), and
  // one is the current route drawn again.
  const driven = bumped('driven', 1000, 5000)
  const alternatives = [bumped('south-1', -1000, 4800), bumped('south-2', -2000, 4900), bumped('south-3', -3000, 5000)]
  const same = bumped('same', 1000, 5100)

  /**
   * The matcher before #35, as a reference for the cost: every vertex of each line within
   * 10 m of the other, each looked up by scanning the other line from its start. Counts its
   * segment distance checks, in meters on a flat plane as it measured them.
   */
  function oldMatcherChecks(path: readonly Corner[], candidates: readonly (readonly Corner[])[]): number {
    let checks = 0
    const toSegment = (p: Corner, a: Corner, b: Corner) => {
      checks++
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const lengthSq = dx * dx + dy * dy
      const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq))
      return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
    }
    const near = (p: Corner, line: readonly Corner[]) => {
      for (let i = 1; i < line.length; i++) if (toSegment(p, line[i - 1]!, line[i]!) <= 10) return true
      return false
    }
    for (const fresh of candidates) {
      // Where the fresh route starts on the path (one full scan), then both ways, vertex by vertex.
      for (let i = 1; i < path.length; i++) toSegment(fresh[0]!, path[i - 1]!, path[i]!)
      if (fresh.every((p) => near(p, path)) && path.every((p) => near(p, fresh))) return checks
    }
    return checks
  }

  const cost = (offered: readonly { route: RouteCandidate }[]) => {
    const meter: MatchMeter = { segmentChecks: 0, gridEntries: 0 }
    const found = findCurrentRoute(driven.route, 0, offered.map((o) => o.route), {}, meter)
    return { found, work: meter.segmentChecks + meter.gridEntries }
  }

  it('the current route not among them: at most twice the old cost', () => {
    expect(driven.xy).toHaveLength(5101)
    const { found, work } = cost(alternatives)
    expect(found).toBeNull()
    expect(work).toBeLessThanOrEqual(2 * oldMatcherChecks(driven.xy, alternatives.map((a) => a.xy)))
  })

  it('the current route among them, offered last: at most twice the old cost, and found', () => {
    const offered = [...alternatives, same]
    const { found, work } = cost(offered)
    expect(found).toBe(same.route)
    expect(work).toBeLessThanOrEqual(2 * oldMatcherChecks(driven.xy, offered.map((a) => a.xy)))
  })

  it('counting changes nothing: the same answer with or without a meter', () => {
    expect(findCurrentRoute(driven.route, 0, [...alternatives, same].map((o) => o.route))).toBe(same.route)
    expect(findCurrentRoute(driven.route, 0, alternatives.map((o) => o.route))).toBeNull()
  })
})


describe('side streets found by probes during a drive (PLAN step 11c, #5)', () => {
  // Each check, the provider offers A (the route being driven) and B from the car, never the
  // side street S (500 m south of A from 6 to 14 km). A is held up (5 minutes over its typical
  // time), so one probe goes out through the via point checkProbes picks, answered the way Mapbox
  // snaps a via: along a road within 250 m of it (viaRadiusM), here only S, or NoSegment. A probed
  // route is asked through a via, so the current path is asked the same way too (its path check,
  // through vias where S leaves it), and the engine compares S with that time only.
  //
  // `bias`: how much lower a time asked through via points comes back than the same path asked
  // as an ordinary route (measured 3 to 13 % with 2 to 10 vias, README). The real times are etaA
  // and etaS; the provider answers A's ordinary check with etaA, and both via-asked requests with
  // the time times (1 - bias).

  const distanceToS = (p: LngLat) => {
    const project = localProjector(p)
    const xy = lineOf('S').map(project)
    let best = Infinity
    for (let i = 1; i < xy.length; i++) best = Math.min(best, pointToSegment([0, 0], xy[i - 1]!, xy[i]!).distanceM)
    return best
  }

  interface ProbedDrive {
    polls: number
    etaA: number
    etaS: number
    bias?: number
    startAlongM?: number
    /** Checks (0 for the first) at which the probe fails (NoSegment, a network error). */
    probeFailsAt?: readonly number[]
    /** Checks at which the path check for the current path fails, so there is no like-for-like time. */
    pathCheckFailsAt?: readonly number[]
    /** Leave the path check out altogether, and compare S with A's ordinary time (the unlike comparison this rules out). */
    unlike?: boolean
    /** The path check's time for A, when it reads otherwise than etaA x (1 - bias). */
    pathCheckSec?: number
    options?: Partial<RerouteOptions>
    /** The drive's probe budget (the back-off among it). */
    budget?: Partial<DriveProbeBudget>
  }

  function probedDrive({ polls, etaA, etaS, bias = 0, startAlongM = 1000, probeFailsAt = [], pathCheckFailsAt = [], unlike = false, pathCheckSec, options = {}, budget = {} }: ProbedDrive) {
    const route = candidate('A', at(0, 0), 2400)!
    const heldUp = { typicalDurationSec: etaA - 300 }
    const viaAsked = (sec: number) => Math.round(sec * (1 - bias))
    let state = INITIAL_REROUTE_STATE
    let memory: CheckProbeMemory = INITIAL_CHECK_PROBES
    const records: { decision: RerouteDecision; vias: LngLat[]; found: boolean }[] = []
    for (let poll = 0; poll < polls; poll++) {
      const alongM = startAlongM + poll * 300
      const here = pointAtDistance(route.geometry, alongM)!.point
      const fresh = [candidate('A', here, etaA, heldUp), candidate('B', here, etaA + 200)].filter((c) => c !== null)
      const vias = checkProbes({ route, alongM, fresh, memory, allowed: 1, budget })
      // Past the point where S leaves A, this network has no road from the car onto S: no route that way.
      const probed = vias.flatMap((via) => {
        const side = probeFailsAt.includes(poll) || distanceToS(via) > 250 ? null : candidate('S', here, viaAsked(etaS), { typicalDurationSec: etaS })
        return side === null ? [] : [{ ...side, via }]
      })
      const candidates = mergeCheckProbes(fresh, null, probed)
      const found = candidates.length > fresh.length
      // The path check a probe needs: the current path asked through via points, as the shell asks it.
      const pathCheck = !found || pathCheckFailsAt.includes(poll) || unlike ? null : [candidate('A', here, pathCheckSec ?? viaAsked(etaA), heldUp)!]
      const decision = decideReroute(
        state,
        { nowSec: poll * 60, route, positionAlongM: alongM, speedMps: 5, candidates, baseline: pathCheck },
        options,
      )
      records.push({ decision, vias, found })
      state = decision.nextState
      memory = rememberCheckProbes(memory, vias.length, decision, candidates, 0, { route, alongM, baseline: pathCheck })
      if (decision.action === 'switch') {
        const to = candidates.find((c) => c.id === decision.toRouteId)!
        return { records, switchedTo: { poll, route: to }, memory }
      }
    }
    return { records, switchedTo: null, memory }
  }

  it('a side street that saves 3 minutes is found by a probe and switched to on the second check in a row, like any route', () => {
    const { records, switchedTo, memory } = probedDrive({ polls: 6, etaA: 2000, etaS: 1820 })
    expect(records.map((r) => r.decision.code)).toEqual(['confirming', 'faster-route'])
    expect(records.every((r) => r.found)).toBe(true)
    expect(records[0]!.decision.reason).toBe('Staying: faster route saves 3 minutes, confirming, check 1 of 2')
    // The second check asked through the same via, so the same side street could come back and be confirmed.
    expect(records[1]!.vias).toEqual(records[0]!.vias)
    expect(nameOf(switchedTo!.route)).toBe('S')
    expect(switchedTo!.route.source).toBe('probe')
    const considered = records[1]!.decision.considered!
    expect(considered).toMatchObject({ savingSec: 180, requiredLeadM: 400, onFreeway: false })
    // Where S leaves A: 6 km, from the car 1.3 km along.
    expect(considered.turnInM).toBeCloseTo(4700, 0)
    expect(records[1]!.decision.reason).toBe('Switching: saves 3 minutes, turn in 2.9 miles')
    // A switch drops the via: the next check starts from the new route.
    expect(memory).toEqual({ used: 2, round: 2, keep: null, losing: 0, losingSlowdown: null })
  })

  it('an equal-time side street never switches, however low the via-asked time comes back (#81)', () => {
    // 10 % low: S reads 1800 s against A's ordinary 2000 s, which would pass both minimums. Compared
    // with A asked the same way (1800 s), it saves nothing.
    for (const bias of [0.03, 0.1, 0.13]) {
      const { records, switchedTo } = probedDrive({ polls: 10, etaA: 2000, etaS: 2000, bias })
      expect(switchedTo, `bias ${bias}`).toBeNull()
      expect(records.filter((r) => r.found).length).toBeGreaterThan(0)
      expect(records.some((r) => r.decision.code === 'confirming')).toBe(false)
    }
  })

  it('a path check that reads higher than the ordinary time never makes a side street look faster (#82 review)', () => {
    // A: 2000 s ordinary, 2150 s through the path check; S 1960 s. Against the ordinary time S saves
    // only 40 s, so it never switches: the lower of the two is the one measured against.
    const { records, switchedTo } = probedDrive({ polls: 10, etaA: 2000, etaS: 1960, pathCheckSec: 2150 })
    expect(switchedTo).toBeNull()
    const onS = records.filter((r) => r.found)
    expect(onS.length).toBeGreaterThan(0)
    expect(new Set(onS.map((r) => r.decision.code))).toEqual(new Set(['saving-too-small']))
    expect(onS[0]!.decision.considered!.savingSec).toBe(40)
  })

  it('a real 3-minute side street still switches with the via bias, compared like for like', () => {
    const { records, switchedTo } = probedDrive({ polls: 6, etaA: 2000, etaS: 1820, bias: 0.1 })
    expect(records.map((r) => r.decision.code)).toEqual(['confirming', 'faster-route'])
    // 1800 s against 1638 s: the saving is measured on the via-asked times of both.
    expect(records[1]!.decision.considered!.savingSec).toBe(162)
    expect(nameOf(switchedTo!.route)).toBe('S')
  })

  it('without a like-for-like time on a check, a side street cannot count, not even towards confirmation', () => {
    // The path check fails on check 1: S is unconfirmed there, the count starts over, and the switch comes on check 3.
    const { records, switchedTo } = probedDrive({ polls: 8, etaA: 2000, etaS: 1820, pathCheckFailsAt: [1] })
    expect(records.map((r) => r.decision.code)).toEqual(['confirming', 'probe-unconfirmed', 'confirming', 'faster-route'])
    expect(records[1]!.decision.reason).toBe('Staying: a side street may be faster, but its time could not be compared like for like')
    expect(records[1]!.decision.nextState.pending).toBeNull()
    expect(switchedTo!.poll).toBe(3)
    // No path check at all: never, whatever S seems to save against A's ordinary time.
    const never = probedDrive({ polls: 10, etaA: 2000, etaS: 1500, unlike: true })
    expect(never.switchedTo).toBeNull()
    expect(new Set(never.records.filter((r) => r.found).map((r) => r.decision.code))).toEqual(new Set(['probe-unconfirmed']))
  })

  it('a side street that saves only 60 s never triggers a switch, however often it is found', () => {
    // (The back-off after probes that keep losing is off here: this is about the engine. See the next test.)
    const { records, switchedTo } = probedDrive({ polls: 12, etaA: 2000, etaS: 1940, budget: { losingChecks: 1e9 } })
    expect(switchedTo).toBeNull()
    // Nothing is being confirmed, so the two sides of the road take turns: S is south, found every other check.
    expect(records.map((r) => r.found)).toEqual(Array.from({ length: 12 }, (_, i) => i % 2 === 0))
    const onS = records.filter((r) => r.found)
    expect(new Set(onS.map((r) => r.decision.code))).toEqual(new Set(['saving-too-small']))
    expect(new Set(records.filter((r) => !r.found).map((r) => r.decision.code))).toEqual(new Set(['current-best']))
    expect(onS[0]!.decision.reason).toBe('Staying: faster route saves only 60 seconds')
    expect(onS[0]!.decision.considered!.savingSec).toBe(60)
  })

  it('probes that keep losing stop after three losses in a row, and the engine still never switches (#183)', () => {
    const { records, switchedTo, memory } = probedDrive({ polls: 12, etaA: 2000, etaS: 1940 })
    expect(switchedTo).toBeNull()
    // The two sides take turns; only the south one finds S. A loss is S found and slower than
    // staying by too little to switch: on checks 1, 3 and 5. The north probes (no road there)
    // tell nothing. After the third loss no probe goes out: the slowdown ahead stays the same.
    expect(records.map((r) => r.vias.length)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0])
    expect(records.filter((r) => r.found)).toHaveLength(3)
    expect(memory).toMatchObject({ round: 5, losing: 3, losingSlowdown: 2000 / 1700 })
  })

  it('probes that failed or found no road are not losses: a side street found later still switches (#183)', () => {
    // The first and third probes fail (no answer): with them counted as losses the back-off would
    // hold before S was ever confirmed.
    const { switchedTo } = probedDrive({ polls: 8, etaA: 2000, etaS: 1820, probeFailsAt: [0, 2] })
    expect(switchedTo).not.toBeNull()
    expect(nameOf(switchedTo!.route)).toBe('S')
  })

  it('a side street is held to 5 % of the time left as well: 2.5 minutes on a 60-minute trip is not enough', () => {
    const { records, switchedTo } = probedDrive({ polls: 8, etaA: 3600, etaS: 3450 })
    expect(switchedTo).toBeNull()
    expect(new Set(records.filter((r) => r.found).map((r) => r.decision.code))).toEqual(new Set(['saving-share-too-small']))
  })

  it('a side street found on one check and missed on the next starts the confirmation over', () => {
    const { records, switchedTo } = probedDrive({ polls: 8, etaA: 2000, etaS: 1820, probeFailsAt: [1] })
    expect(records.map((r) => r.found)).toEqual([true, false, true, true])
    // The check that missed it had no winner (B is slower): the count starts again.
    expect(records.map((r) => r.decision.code)).toEqual(['confirming', 'current-best', 'confirming', 'faster-route'])
    expect(switchedTo!.poll).toBe(3)
  })

  it('needs as many checks in a row as confirmPolls says, for a side street too', () => {
    const { records, switchedTo } = probedDrive({ polls: 8, etaA: 2000, etaS: 1820, options: { confirmPolls: 3 } })
    expect(records.map((r) => r.decision.code)).toEqual(['confirming', 'confirming', 'faster-route'])
    expect(switchedTo!.poll).toBe(2)
  })

  it('a side street whose turn-off is too close is refused, whatever it saves', () => {
    // The first check (5.4 km along A) probes the north side; the second, from 5.7 km, finds S,
    // which turns off 300 m ahead: under the 400 m lead. After that its turn-off is behind the car.
    const { records, switchedTo } = probedDrive({ polls: 4, etaA: 2000, etaS: 1700, startAlongM: 5400 })
    expect(records.map((r) => r.found)).toEqual([false, true, false, false])
    expect(records[1]!.decision.code).toBe('too-late')
    expect(records[1]!.decision.reason).toMatch(/^Staying: faster route turns off in .+, too late to take safely$/)
    expect(records[1]!.decision.considered!.turnInM).toBeCloseTo(300, 0)
    expect(switchedTo).toBeNull()
  })

  it('a route that is not held up is not probed: no jam reported and under 2 minutes over its typical time', () => {
    const route = candidate('A', at(0, 0), 2400)!
    const here = at(1000, 0)
    const vias = (typicalDurationSec: number) =>
      checkProbes({ route, alongM: 1000, fresh: [candidate('A', here, 2000, { typicalDurationSec })!, candidate('B', here, 2200)!], memory: INITIAL_CHECK_PROBES, allowed: 1 })
    expect(vias(2000)).toEqual([])
    expect(vias(1881)).toEqual([])
    expect(vias(1880)).toHaveLength(1)
  })
})

describe('the lead is judged where the driver is when the answer is used (#5 review)', () => {
  // A slow answer (a probe that drags on weak signal): asked 1.3 km along A, used once the car
  // has gone on. B leaves A at 5 km.
  const decide = (drivenSinceM: number | undefined) => {
    const here = at(4300, 0)
    return decideReroute(
      INITIAL_REROUTE_STATE,
      {
        nowSec: 0,
        route: { geometry: candidate('A', at(0, 0), 2400)!.geometry, maneuvers: [], limitedAccessSpansM: null },
        positionAlongM: 4300,
        speedMps: 15,
        candidates: [candidate('A', here, 2000)!, candidate('B', here, 1700)!],
        ...(drivenSinceM === undefined ? {} : { drivenSinceM }),
      },
      NO_CONFIRM,
    )
  }

  it('a turn-off 700 m from where the check was asked is taken when the answer is quick', () => {
    expect(decide(undefined)).toMatchObject({ action: 'switch', considered: { turnInM: expect.closeTo(700, 0) } })
    expect(decide(0).action).toBe('switch')
  })

  it('and refused when the car went 375 m while the answer was out: 325 m left is under the 400 m lead', () => {
    const late = decide(375)
    expect(late.code).toBe('too-late')
    expect(late.considered!.turnInM).toBeCloseTo(325, 0)
    expect(late.reason).toMatch(/turns off in .+, too late to take safely$/)
  })

  it('what is said counts from the car too, and a value that is not a distance is 0', () => {
    expect(decide(200)).toMatchObject({ action: 'switch', considered: { turnInM: expect.closeTo(500, 0) } })
    expect(decide(NaN).considered!.turnInM).toBeCloseTo(700, 0)
    expect(decide(-50).considered!.turnInM).toBeCloseTo(700, 0)
  })
})
