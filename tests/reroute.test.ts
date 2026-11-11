import { describe, expect, it } from 'vitest'
import {
  alongRouteM,
  baselineProbe,
  bearingDeg,
  decideReroute,
  declineRoute,
  DEFAULT_REROUTE_OPTIONS,
  findCurrentRoute,
  INITIAL_REROUTE_STATE,
  lineFrom,
  pointAtDistance,
  type LngLat,
  type RerouteDecision,
  type RerouteOptions,
  type RerouteState,
  type RouteCandidate,
} from '../src/core/index.ts'
import { at, candidate, drive, nameOf, type DriveScript, type PollContext, type RouteName } from './helpers/driveWorld.ts'

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
      offRouteM: 50,
      sameRouteToleranceM: 10,
      matchToleranceM: 20,
      matchMinOverlap: 0.95,
      matchMaxGapM: 400,
      matchIgnoreStartM: 150,
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

  // Review of the overlap rule: where its loose side ends. A stretch apart shorter than
  // matchMaxGapM that also fits in the 5% allowance is NOT told from the current route,
  // however far to the side it runs. One city block around is such a stretch.
  it('known limit: one block around counts as the current route on a long trip, two blocks or a short trip do not', () => {
    /** North one 125 m block at xM, east `blocks` blocks, and back down to the main road. */
    const around = (xM: number, blocks: number): Corner[] => [[xM, 0], [xM, 125], [xM + 125 * blocks, 125], [xM + 125 * blocks, 0]]
    // 17 km to go, about 340 m of the fresh line apart: inside both limits.
    const oneBlock: Corner[] = [[HERE, 0], ...around(10000, 1), [20000, 0]]
    expect(isCurrent(oneBlock)).toBe(true)
    // So it is never weighed as an alternative, whatever time it claims; the exact drawing gives the ETA.
    const both = decideReroute(INITIAL_REROUTE_STATE, {
      nowSec: 0,
      route: onA,
      positionAlongM: HERE,
      speedMps: 20,
      candidates: [fresh(oneBlock, 1700), candidate('A', at(HERE, 0), 2000)!],
    })
    expect(both).toMatchObject({ action: 'stay', code: 'no-alternative', current: { durationSec: 2000, asked: false } })
    // Offered alone (the provider routes round that block), the driven line and its guidance are
    // kept and only the time is taken from it: the engine does not see the block as left.
    const alone = decideReroute(INITIAL_REROUTE_STATE, { nowSec: 0, route: onA, positionAlongM: HERE, speedMps: 20, candidates: [fresh(oneBlock, 1700)] })
    expect(alone).toMatchObject({ action: 'stay', code: 'no-alternative', current: { durationSec: 1700 } })
    // Two blocks: the stretch apart is longer than matchMaxGapM.
    expect(isCurrent([[HERE, 0], ...around(10000, 2), [20000, 0]])).toBe(false)
    // One block with 5 km to go: more than 5% of what is left.
    expect(findCurrentRoute(onA, 15000, [fresh([[15000, 0], ...around(17000, 1), [20000, 0]])])).toBeNull()
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

  it('a poll that could not ask for the current path neither adds to the count nor clears it', () => {
    const state: RerouteState = { ...INITIAL_REROUTE_STATE, lostPolls: 2 }
    const notAsked = pollOnA({ xM: 1000, etas: { B: 1500 }, state })
    expect(notAsked).toMatchObject({ action: 'stay', code: 'route-unconfirmed' })
    expect(notAsked.nextState.lostPolls).toBe(2)
    // "No route through these points" is the answer that counts: the third in a row.
    expect(pollOnA({ xM: 1000, etas: { B: 1500 }, state, baseline: {} })).toMatchObject({ action: 'switch', code: 'route-lost' })
    // Answered with another road (the via points did not pin the path): no evidence, and the count starts again.
    const otherRoad = pollOnA({ xM: 1000, etas: { B: 1500 }, state, baseline: { B: 1500 } })
    expect(otherRoad).toMatchObject({ action: 'stay', code: 'route-unconfirmed' })
    expect(otherRoad.reason).toBe('Staying: current route is not among the fresh routes, and asking for it brought back another road')
    expect(otherRoad.nextState.lostPolls).toBe(0)
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

