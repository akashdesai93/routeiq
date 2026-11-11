import { describe, expect, it } from 'vitest'
import {
  alongRouteM,
  decideReroute,
  findCurrentRoute,
  INITIAL_REROUTE_STATE,
  pointAtDistance,
  type LngLat,
  type RerouteDecision,
  type RouteCandidate,
} from '../src/core/index.ts'
import {
  advance,
  afterRequest,
  afterSwitch,
  cruiseSpeedMps,
  DEFAULT_DRIVE_SETTINGS,
  DRIVE_START,
  formatSimClock,
  MIN_REQUEST_GAP_MS,
  pollGate,
  SPEED_MULTIPLIERS,
  withWhatIfDelay,
  type DriveClock,
} from '../src/drive/simulation.ts'
import { fetchFreshRoutes } from '../src/drive/freshRoutes.ts'
import { driveFeatures } from '../src/map/driveFeatures.ts'
import { createOverpassClient } from '../src/providers/osm/client.ts'
import { memoryBundleLayer } from '../src/providers/osm/bundleLayer.ts'
import { createTileSource, memoryTileStore, overpassLayer } from '../src/providers/osm/tileSource.ts'
import { askOnce, loadSignalData, type SignalSources } from '../src/signalData.ts'
import { at, candidate, nameOf, type RouteName } from './helpers/driveWorld.ts'
import { fakeClock, fakeOverpass } from './helpers/overpass.ts'

// The simulated drive of PLAN step 6, without the browser: the simulated clock, the request
// budget, the what-if delay, the once-only signal sources and the map features. No network.

describe('simulated clock', () => {
  it('offers 1x, 5x and 20x', () => {
    expect(SPEED_MULTIPLIERS).toEqual([1, 5, 20])
  })

  it('runs simulated time at the multiplier and moves the car at its speed', () => {
    const once = advance(DRIVE_START, 100, 20, 15, 10_000)
    expect(once.simTimeSec).toBeCloseTo(2)
    expect(once.alongM).toBeCloseTo(30)
    expect(advance(DRIVE_START, 100, 1, 15, 10_000).alongM).toBeCloseTo(1.5)
    // The end of the route is the end.
    expect(advance({ ...DRIVE_START, alongM: 9_990 }, 1000, 20, 15, 10_000).alongM).toBe(10_000)
  })

  it('ignores a step that is not a forward step, and caps one from a sleeping tab', () => {
    expect(advance(DRIVE_START, -5, 20, 15, 10_000)).toBe(DRIVE_START)
    expect(advance(DRIVE_START, NaN, 20, 15, 10_000)).toBe(DRIVE_START)
    expect(advance(DRIVE_START, 60_000, 20, 15, 10_000).simTimeSec).toBe(20)
  })

  it('drives a route at its own average speed, within sane bounds', () => {
    expect(cruiseSpeedMps({ distanceM: 30_000, durationSec: 2_000 })).toBe(15)
    expect(cruiseSpeedMps({ distanceM: 30_000, durationSec: 0 })).toBe(13)
    expect(cruiseSpeedMps({ distanceM: 10, durationSec: 2_000 })).toBe(1.5)
    expect(cruiseSpeedMps({ distanceM: 900_000, durationSec: 100 })).toBe(45)
  })

  it('shows simulated time as a stopwatch', () => {
    expect(formatSimClock(0)).toBe('0:00')
    expect(formatSimClock(725.9)).toBe('12:05')
    expect(formatSimClock(3723)).toBe('1:02:03')
    expect(formatSimClock(NaN)).toBe('0:00')
  })
})

describe('request budget', () => {
  it('has the documented defaults: a check every 60 simulated seconds, 60 requests a drive, 5 real seconds apart', () => {
    expect(DEFAULT_DRIVE_SETTINGS).toEqual({ pollIntervalSec: 60, maxRequests: 60 })
    expect(MIN_REQUEST_GAP_MS).toBe(5000)
  })

  it('is due only after the interval, inside the budget, and five real seconds after the last request', () => {
    const at59: DriveClock = { ...DRIVE_START, simTimeSec: 59.9 }
    expect(pollGate(at59, 1_000, DEFAULT_DRIVE_SETTINGS)).toBe('not-yet')
    const at60: DriveClock = { ...DRIVE_START, simTimeSec: 60 }
    expect(pollGate(at60, 1_000, DEFAULT_DRIVE_SETTINGS)).toBe('due')
    const asked = afterRequest(at60, 1_000)
    expect(asked).toMatchObject({ lastPollSimSec: 60, lastRequestRealMs: 1_000, requestsUsed: 1 })
    const soon: DriveClock = { ...asked, simTimeSec: 120 }
    expect(pollGate(soon, 5_999, DEFAULT_DRIVE_SETTINGS)).toBe('request-gap')
    expect(pollGate(soon, 6_000, DEFAULT_DRIVE_SETTINGS)).toBe('due')
    expect(pollGate({ ...soon, requestsUsed: 60 }, 60_000, DEFAULT_DRIVE_SETTINGS)).toBe('budget-spent')
    expect(pollGate(soon, 60_000, { pollIntervalSec: 60, maxRequests: 0 })).toBe('budget-spent')
    expect(pollGate(soon, 60_000, { pollIntervalSec: 60, maxRequests: NaN })).toBe('budget-spent')
    // A poll interval typed as 0 or 1 does not turn into a request per tick.
    expect(pollGate({ ...DRIVE_START, simTimeSec: 9 }, 60_000, { pollIntervalSec: 0, maxRequests: 60 })).toBe('not-yet')
    expect(pollGate({ ...DRIVE_START, simTimeSec: 10 }, 60_000, { pollIntervalSec: 0, maxRequests: 60 })).toBe('due')
    // A switch restarts the distance, not the budget.
    expect(afterSwitch({ ...asked, alongM: 4_000 })).toEqual({ ...asked, alongM: 0 })
  })

  for (const multiplier of SPEED_MULTIPLIERS) {
    it(`at ${multiplier}x a 35 minute drive never asks more often than every 5 real seconds, nor more than 60 times`, () => {
      // The timer of useDriveSim, with real time counted by hand: a tick every 100 ms.
      let clock = DRIVE_START
      const requestsAtMs: number[] = []
      const requestsAtSimSec: number[] = []
      for (let realMs = 0; clock.alongM < 31_500; realMs += 100) {
        clock = advance(clock, 100, multiplier, 15, 31_500)
        if (pollGate(clock, realMs, DEFAULT_DRIVE_SETTINGS) === 'due') {
          clock = afterRequest(clock, realMs)
          requestsAtMs.push(realMs)
          requestsAtSimSec.push(clock.simTimeSec)
        }
      }
      expect(clock.simTimeSec).toBeCloseTo(2100, 0)
      requestsAtMs.forEach((ms, i) => {
        if (i > 0) expect(ms - requestsAtMs[i - 1]!).toBeGreaterThanOrEqual(MIN_REQUEST_GAP_MS)
      })
      requestsAtSimSec.forEach((sec, i) => {
        if (i > 0) expect(sec - requestsAtSimSec[i - 1]!).toBeGreaterThanOrEqual(60)
      })
      expect(requestsAtMs.length).toBeLessThanOrEqual(DEFAULT_DRIVE_SETTINGS.maxRequests)
      // 1x and 5x check every simulated minute; at 20x the 5 second rule stretches that to 100 s.
      // (The count can be one more or less where the last check falls on the moment of arrival.)
      expect(Math.abs(requestsAtMs.length - (multiplier === 20 ? 20 : 34))).toBeLessThanOrEqual(1)
      expect(clock.requestsUsed).toBe(requestsAtMs.length)
    })
  }

  it('stops asking when the budget is spent, however long the drive', () => {
    let clock = DRIVE_START
    const settings = { pollIntervalSec: 60, maxRequests: 7 }
    for (let realMs = 0; realMs < 600_000; realMs += 100) {
      clock = advance(clock, 100, 5, 15, 1e9)
      if (pollGate(clock, realMs, settings) === 'due') clock = afterRequest(clock, realMs)
    }
    expect(clock.requestsUsed).toBe(7)
    expect(pollGate(clock, 600_000, settings)).toBe('budget-spent')
  })
})

describe('what-if delay (simulated data)', () => {
  const driven = candidate('A', at(0, 0), 2000)!
  const here = at(2000, 0)
  const fresh = [candidate('B', here, 1900)!, candidate('A', here, 1800)!, candidate('C', here, 1950)!]

  it('adds the delay to the candidate that is the rest of the current route, and to nothing else', () => {
    const delayed = withWhatIfDelay(fresh, driven, 2000, 300)
    expect(delayed.map((c) => [nameOf(c), c.durationSec])).toEqual([
      ['B', 1900],
      ['A', 2100],
      ['C', 1950],
    ])
    // Copies: the poll's own answer is untouched, and so is everything but the time.
    expect(fresh[1]!.durationSec).toBe(1800)
    expect(delayed[1]).toEqual({ ...fresh[1]!, durationSec: 2100 })
    expect(delayed[0]).toBe(fresh[0])
  })

  it('changes nothing without a delay or without the current route among the candidates', () => {
    expect(withWhatIfDelay(fresh, driven, 2000, 0)).toBe(fresh)
    expect(withWhatIfDelay(fresh, driven, 2000, -60)).toBe(fresh)
    expect(withWhatIfDelay(fresh, driven, 2000, NaN)).toBe(fresh)
    const others = [fresh[0]!, fresh[2]!]
    expect(withWhatIfDelay(others, driven, 2000, 300)).toBe(others)
  })
})

describe('a whole simulated drive, offline', () => {
  /**
   * What useDriveSim does, with the made-up road network standing in for
   * Mapbox and real time counted by hand: tick, poll when due, apply the
   * what-if delay, ask the engine, apply a switch.
   */
  function simulate(options: { multiplier: number; whatIfFromSimSec: number | null; delaySec: number }) {
    const etas: Partial<Record<RouteName, number>> = { A: 1300, B: 1400, C: 1450 }
    let route: RouteCandidate = candidate('A', at(0, 0), 1300)!
    let lengthM = alongRouteM(route.geometry).at(-1)!
    let speedMps = cruiseSpeedMps(route)
    let clock = DRIVE_START
    let engine = INITIAL_REROUTE_STATE
    let delaySec = 0
    const decisions: (RerouteDecision & { simTimeSec: number; simulated: boolean })[] = []
    const driven: RouteName[] = ['A']

    for (let realMs = 0; clock.alongM < lengthM; realMs += 100) {
      clock = advance(clock, 100, options.multiplier, speedMps, lengthM)
      if (options.whatIfFromSimSec !== null && clock.simTimeSec >= options.whatIfFromSimSec && driven.length === 1) {
        delaySec = options.delaySec
      }
      if (pollGate(clock, realMs, DEFAULT_DRIVE_SETTINGS) !== 'due') continue
      clock = afterRequest(clock, realMs)
      const here = pointAtDistance(route.geometry, clock.alongM)!
      const fresh = (Object.keys(etas) as RouteName[])
        .map((name) => candidate(name, here.point, etas[name]! * (1 - clock.simTimeSec / 2000)))
        .filter((c): c is RouteCandidate => c !== null)
        // Past the last junction the names are one road: keep one.
        .filter((c, i, all) => all.findIndex((o) => Math.abs(o.distanceM - c.distanceM) < 1) === i)
      const candidates = withWhatIfDelay(fresh, route, clock.alongM, delaySec)
      const decision = decideReroute(engine, {
        nowSec: clock.simTimeSec,
        route,
        positionAlongM: clock.alongM,
        speedMps,
        candidates,
      })
      engine = decision.nextState
      decisions.push({ ...decision, simTimeSec: clock.simTimeSec, simulated: candidates !== fresh })
      if (decision.action === 'switch') {
        route = fresh.find((c) => c.id === decision.toRouteId)!
        lengthM = alongRouteM(route.geometry).at(-1)!
        speedMps = cruiseSpeedMps(route)
        clock = afterSwitch(clock)
        delaySec = 0
        driven.push(nameOf(route))
      }
    }
    return { decisions, driven, clock }
  }

  it('without a what-if delay it stays on its route to the end', () => {
    const { decisions, driven, clock } = simulate({ multiplier: 5, whatIfFromSimSec: null, delaySec: 0 })
    expect(driven).toEqual(['A'])
    expect(decisions.length).toBeGreaterThan(15)
    expect(decisions.every((d) => d.action === 'stay' && !d.simulated)).toBe(true)
    expect(clock.requestsUsed).toBe(decisions.length)
  })

  it('a +5 minute what-if delay makes exactly one switch, two checks later, and is then gone', () => {
    const { decisions, driven } = simulate({ multiplier: 5, whatIfFromSimSec: 100, delaySec: 300 })
    expect(driven).toEqual(['A', 'B'])
    const flagged = decisions.filter((d) => d.simulated)
    expect(flagged.map((d) => d.code)).toEqual(['confirming', 'faster-route'])
    expect(flagged.map((d) => Math.round(d.simTimeSec))).toEqual([120, 180])
    expect(flagged[1]!.reason).toMatch(/^Switching: saves 3\.\d minutes, turn in 1\.\d miles$/)
    expect(decisions.filter((d) => d.action === 'switch')).toHaveLength(1)
    // After the switch the delay is cleared, so the old route does not look slow for ever.
    expect(decisions.slice(decisions.indexOf(flagged[1]!) + 1).some((d) => d.simulated)).toBe(false)
  })

  it('is the same drive every time', () => {
    const run = () => simulate({ multiplier: 20, whatIfFromSimSec: 100, delaySec: 300 })
    const outline = (r: ReturnType<typeof run>) => r.decisions.map((d) => [d.simTimeSec, d.action, d.code, d.reason])
    expect(outline(run())).toEqual(outline(run()))
    expect(run().driven).toEqual(['A', 'B'])
  })

  it('findCurrentRoute keeps following the car after a switch', () => {
    const b = candidate('B', at(3000, 0), 1500)!
    const later = pointAtDistance(b.geometry, 4000)!.point
    expect(nameOf(findCurrentRoute(b, 4000, [candidate('BA', later, 900)!, candidate('B', later, 1000)!])!)).toBe('B')
  })
})

describe('askOnce: signal sources for a drive that polls', () => {
  /** A road across two tiles: the west one is in the bundle, the east one is not. */
  const WEST = '-809_352'
  const EAST = '-808_352'
  const road: RouteCandidate = {
    ...candidate('A', at(0, 0), 600)!,
    geometry: [
      [-80.81, 35.25],
      [-80.79, 35.25],
    ],
  }

  function setup(east: number | (readonly [number, number, number])[]) {
    const clock = fakeClock()
    const server = fakeOverpass({ [EAST]: east })
    const inner: SignalSources = {
      tiles: createTileSource({
        cache: memoryTileStore(),
        bundle: memoryBundleLayer([{ tileId: WEST, fetchedAt: clock.now(), nodes: [{ id: 1, lng: -80.805, lat: 35.25 }] }]),
        network: overpassLayer(createOverpassClient({ fetchImpl: server.fetchImpl, now: clock.now })),
        now: clock.now,
      }),
    }
    return { clock, server, inner }
  }

  it('the plain tile source asks again for a failed tile once its wait is over: not good enough for a drive', async () => {
    const { clock, server, inner } = setup(503)
    for (let poll = 0; poll < 40; poll++) {
      await loadSignalData([road], inner)
      clock.advance(60_000)
    }
    expect(server.requested().filter((id) => id === EAST).length).toBeGreaterThan(1)
    expect(server.requested()).not.toContain(WEST)
  })

  it('asks for a tile outside the bundle at most once, however long the drive, and never for a bundled one', async () => {
    const { clock, server, inner } = setup(503)
    const once = askOnce(inner)
    for (let poll = 0; poll < 40; poll++) {
      const loaded = await loadSignalData([road], once)
      expect(loaded.missingTileIds).toEqual([EAST])
      expect([...loaded.data.primaryTileIds]).toEqual([WEST])
      clock.advance(60_000)
    }
    expect(server.requested()).toEqual([EAST])
  })

  it('a tile that did load is simply kept', async () => {
    const { server, inner } = setup([[2, -80.795, 35.25]])
    const once = askOnce(inner)
    for (let poll = 0; poll < 5; poll++) {
      const loaded = await loadSignalData([road], once)
      expect(loaded.missingTileIds).toEqual([])
      expect(loaded.data.primary).toHaveLength(2)
    }
    expect(server.requested()).toEqual([EAST])
  })
})

describe('fetchFreshRoutes: one check, and the current path asked for when it is missing', () => {
  /** No signal data at all: this is about the Directions requests. */
  const signalSources: SignalSources = {
    tiles: { load: (ids) => Promise.resolve({ tiles: new Map(), missing: [...ids], partial: new Map() }) },
  }
  /** A Directions body for routes of the made-up network. */
  const body = (routes: readonly RouteCandidate[]) => ({
    code: 'Ok',
    routes: routes.map((r) => ({ duration: r.durationSec, duration_typical: r.durationSec, distance: r.distanceM, geometry: { type: 'LineString', coordinates: r.geometry } })),
  })
  /** Stands in for fetch: answers the calls in order with the given bodies (a number is an HTTP error). */
  function server(...answers: (object | number)[]) {
    const urls: URL[] = []
    const fetchImpl = ((input: RequestInfo | URL) => {
      urls.push(new URL(String(input)))
      const answer = answers[urls.length - 1] ?? 500
      return Promise.resolve(typeof answer === 'number' ? new Response('', { status: answer }) : new Response(JSON.stringify(answer), { status: 200 }))
    }) as typeof fetch
    return { fetchImpl, urls }
  }
  const driven = candidate('A', at(0, 0), 2000)!
  const here = at(3000, 0)
  const ask = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof fetchFreshRoutes>[0]> = {}) =>
    fetchFreshRoutes({ token: 'pk.test', origin: here, destination: at(20_000, 0), headingDeg: 90, fetchImpl, signalSources, baseline: { route: driven, alongM: 3000 }, ...extra })

  it('one request when the current route is among the fresh routes', async () => {
    const { fetchImpl, urls } = server(body([candidate('A', here, 1500)!, candidate('B', here, 1450)!]))
    const result = await ask(fetchImpl)
    expect(result).toMatchObject({ ok: true, baseline: null, requests: 1, simulated: false })
    expect(urls).toHaveLength(1)
    expect(urls[0]!.searchParams.has('waypoints')).toBe(false)
  })

  it('a second request, through via points on the current path, when it is not; its answer is the baseline', async () => {
    const { fetchImpl, urls } = server(body([candidate('B', here, 1450)!]), body([candidate('A', here, 1500)!]))
    const result = await ask(fetchImpl)
    expect(urls).toHaveLength(2)
    // Origin, four points along the main road where B leaves it, destination; one leg; no alternatives.
    expect(urls[1]!.pathname.split('/').at(-1)!.split('%3B')).toHaveLength(6)
    expect(urls[1]!.searchParams.get('waypoints')).toBe('0;5')
    expect(urls[1]!.searchParams.get('alternatives')).toBe('false')
    expect(urls[1]!.searchParams.get('bearings')).toBe('90,45;90,45;90,45;90,45;90,45;')
    if (!result.ok) throw new Error('expected routes')
    expect(result.requests).toBe(2)
    expect(result.fresh).toHaveLength(1)
    expect(result.baseline).toHaveLength(1)
    expect(result.baseline![0]!.durationSec).toBe(1500)
    // The engine then compares like for like: B saves 50 s on the main road's own fresh time.
    const decision = decideReroute(INITIAL_REROUTE_STATE, { nowSec: 0, route: driven, positionAlongM: 3000, speedMps: 15, candidates: result.candidates, baseline: result.baseline })
    expect(decision).toMatchObject({ action: 'stay', code: 'saving-too-small', current: { durationSec: 1500, asked: true } })
  })

  it('the what-if delay lands on the current path wherever its time came from', async () => {
    const { fetchImpl } = server(body([candidate('B', here, 1450)!]), body([candidate('A', here, 1500)!]))
    const result = await ask(fetchImpl, { whatIf: { route: driven, alongM: 3000, delaySec: 300 } })
    if (!result.ok) throw new Error('expected routes')
    expect(result.simulated).toBe(true)
    expect(result.baseline![0]!.durationSec).toBe(1800)
    expect(result.candidates[0]!.durationSec).toBe(1450)
  })

  it('without leave it never asks twice; a failed second request is no answer, and "no route" is an empty one', async () => {
    const onlyB = body([candidate('B', here, 1450)!])
    const notAllowed = server(onlyB)
    expect(await ask(notAllowed.fetchImpl, { baseline: null })).toMatchObject({ ok: true, baseline: null, requests: 1 })
    expect(notAllowed.urls).toHaveLength(1)
    expect(await ask(server(onlyB, 503).fetchImpl)).toMatchObject({ ok: true, baseline: null, requests: 2 })
    expect(await ask(server(onlyB, { code: 'NoRoute', routes: [] }).fetchImpl)).toMatchObject({ ok: true, baseline: [], requests: 2 })
  })
})

describe('driveFeatures', () => {
  const car: LngLat = [-80.85, 35.2]
  const routeAhead: LngLat[] = [car, [-80.85, 35.1], [-80.86, 35.0]]

  it('draws nothing without a drive', () => {
    expect(driveFeatures(null)).toEqual({ type: 'FeatureCollection', features: [] })
  })

  it('gives the route, then the turn-off, then the car on top', () => {
    const { features } = driveFeatures({ car, routeAhead, turn: { at: [-80.85, 35.15], pending: true } })
    expect(features.map((f) => [f.properties.kind, f.geometry.type, f.properties.pending])).toEqual([
      ['route', 'LineString', false],
      ['turn', 'Point', true],
      ['car', 'Point', false],
    ])
    expect(features[0]!.geometry.coordinates).toEqual(routeAhead)
    expect(features[2]!.geometry.coordinates).toEqual(car)
  })

  it('leaves out a route with no length (arrived) and a turn that is not there', () => {
    const { features } = driveFeatures({ car, routeAhead: [car], turn: null })
    expect(features.map((f) => f.properties.kind)).toEqual(['car'])
  })
})
