import { describe, expect, it } from 'vitest'
import {
  alongRouteM,
  bearingDeg,
  decideReroute,
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
}

/** One poll while driving the main road A, x meters along it. */
function pollOnA(setup: PollSetup): RerouteDecision & { candidates: RouteCandidate[] } {
  const here = at(setup.xM, 0)
  const candidates = (Object.keys(setup.etas) as RouteName[])
    .map((name) => candidate(name, here, setup.etas[name]!, setup.extra?.[name]))
    .filter((c): c is RouteCandidate => c !== null)
  const decision = decideReroute(
    setup.state ?? INITIAL_REROUTE_STATE,
    {
      nowSec: setup.nowSec ?? 0,
      route: { geometry: candidate('A', at(0, 0), 2000)!.geometry, maneuvers: [], limitedAccessSpansM: null },
      positionAlongM: setup.xM,
      speedMps: setup.speedMps ?? 5,
      candidates,
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

  it('current route not among the candidates: waits three polls, then takes the best fresh route', () => {
    const log = drive({
      polls: 6,
      eta: fixed({ A: 2000, B: 1900, C: 1950 }),
      tamper: (candidates, { poll }) => (poll >= 1 ? candidates.filter((c) => nameOf(c) !== 'A') : candidates),
    })
    expect(log.codes.slice(0, 4)).toEqual(['saving-too-small', 'route-lost-waiting', 'route-lost-waiting', 'route-lost'])
    expect(log.polls[1]!.decision.reason).toBe('Staying: current route is missing from the fresh routes, check 1 of 3')
    expect(log.polls[3]!.decision.reason).toBe('Switching: current route is no longer offered, turn in 2.5 miles')
    expect(log.polls[3]!.decision.considered!.savingSec).toBeNull()
    expect(log.switches).toEqual([{ nowSec: 180, from: 'A', to: 'B' }])
  })

  it('current route not among the candidates: the route left a moment ago may be the one to take', () => {
    // On B since the switch at 60 s. Then the provider stops offering B and puts A first.
    const log = drive({
      polls: 9,
      eta: (name, { poll }) => (name === 'A' ? (poll >= 2 ? 1700 : 2000) : name === 'B' ? 1820 : name === 'C' ? 1900 : null),
      tamper: (candidates, { poll }) => (poll >= 2 ? candidates.filter((c) => nameOf(c) !== 'B') : candidates),
    })
    expect(log.codes.slice(0, 8)).toEqual([
      'confirming',
      'faster-route',
      'route-lost-waiting',
      'route-lost-waiting',
      // Three polls without it, but the cooldown (until 360 s) still holds.
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
      'Staying: switched routes 3 minutes ago, and the current route is no longer offered',
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
    // 300 m on, the answer is stale: nothing matches, and nothing is switched on one such poll.
    expect(poll(3300)).toMatchObject({ action: 'stay', code: 'route-lost-waiting' })
  })

  it('current route missing for one poll only: the count starts again', () => {
    const log = drive({
      polls: 8,
      eta: fixed({ A: 2000, B: 1900 }),
      tamper: (candidates, { poll }) => (poll % 3 === 1 ? candidates.filter((c) => nameOf(c) !== 'A') : candidates),
    })
    expect(log.switches).toEqual([])
    expect(log.codes).toEqual(['saving-too-small', 'route-lost-waiting', 'saving-too-small', 'saving-too-small', 'route-lost-waiting', 'saving-too-small', 'saving-too-small', 'route-lost-waiting'])
    expect(log.polls.map((p) => p.decision.nextState.lostPolls)).toEqual([0, 1, 0, 0, 1, 0, 0, 1])
  })

  it('current route no longer offered and the only other route turns off too soon: stays', () => {
    const lost = pollOnA({ xM: 4700, etas: { B: 1500 }, options: { routeLostPolls: 1 } })
    expect(lost).toMatchObject({ action: 'stay', code: 'too-late' })
    expect(lost.reason).toBe(
      'Staying: current route is no longer offered, but the other route turns off in 0.1 miles, too late to take safely',
    )
    // Inside the cooldown it waits as well.
    const cooling = pollOnA({
      xM: 1000,
      nowSec: 100,
      etas: { B: 1500 },
      options: { routeLostPolls: 1 },
      state: { ...INITIAL_REROUTE_STATE, lastSwitchAtSec: 0 },
    })
    expect(cooling).toMatchObject({ action: 'stay', code: 'cooldown' })
    expect(pollOnA({ xM: 1000, etas: { B: 1500 }, options: { routeLostPolls: 1 } })).toMatchObject({
      action: 'switch',
      code: 'route-lost',
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
