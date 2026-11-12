import { describe, expect, it } from 'vitest'
import {
  alongRouteM,
  distanceM,
  decideReroute,
  findCurrentRoute,
  INITIAL_CHECK_PROBES,
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
import { driveMarkerFeatures, driveRouteFeatures, routeProgress } from '../src/map/driveFeatures.ts'
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

describe('askOnce: a bundled tile that could not be read is not given up on (#73)', () => {
  const WEST = '-809_352'
  const EAST = '-808_352'
  const westTile = { tileId: WEST, fetchedAt: 1, nodes: [{ id: 1, lng: -80.805, lat: 35.25 }] }

  it('a covered tile whose file read failed once is read again on a later check', async () => {
    // The repro of #73: the first read of the file fails (a dead zone), later ones work.
    const clock = fakeClock()
    let reads = 0
    const bundle = {
      coverage: () => Promise.resolve('covered' as const),
      get: () => Promise.resolve(++reads === 1 ? null : westTile),
    }
    const asked: string[] = []
    const network = { get: (id: string) => (asked.push(id), Promise.resolve(null)) }
    const drive = askOnce({ tiles: createTileSource({ bundle, cache: memoryTileStore(), network, now: clock.now }) })
    const first = await drive.tiles.load([WEST])
    expect(first.missing).toEqual([WEST])
    expect(first.awaitingBundle).toEqual([WEST])
    // A check a second later is inside the small wait: no read, still missing, still not given up.
    clock.advance(1_000)
    expect((await drive.tiles.load([WEST])).missing).toEqual([WEST])
    expect(reads).toBe(1)
    clock.advance(60_000)
    const later = await drive.tiles.load([WEST])
    expect(later.missing).toEqual([])
    expect(later.tiles.get(WEST)).toEqual(westTile)
    expect(reads).toBe(2)
    expect(asked).toEqual([])
  })

  it('keeps trying a bundled tile through a long dead zone, while a tile outside the bundle is still asked of Overpass once', async () => {
    const clock = fakeClock()
    let online = false
    let reads = 0
    const bundle = {
      coverage: (id: string) => Promise.resolve(id === WEST ? ('covered' as const) : ('none' as const)),
      get: () => (reads++, Promise.resolve(online ? westTile : null)),
    }
    const asked: string[] = []
    const network = { get: (id: string) => (asked.push(id), Promise.resolve(null)) }
    const drive = askOnce({ tiles: createTileSource({ bundle, cache: memoryTileStore(), network, now: clock.now }) })
    for (let check = 0; check < 30; check++) {
      const loaded = await drive.tiles.load([WEST, EAST])
      expect(loaded.missing).toEqual([WEST, EAST])
      expect(loaded.awaitingBundle).toEqual([WEST])
      clock.advance(60_000)
    }
    expect(reads).toBeGreaterThan(1)
    online = true
    const loaded = await drive.tiles.load([WEST, EAST])
    expect(loaded.missing).toEqual([EAST])
    expect([...loaded.tiles.keys()]).toEqual([WEST])
    // The once-per-session rule is for Overpass tiles only, and it still holds.
    expect(asked).toEqual([EAST])
  })

  it('a tile that waited on an unreadable index is asked of Overpass at most once after the index says it is outside', async () => {
    const clock = fakeClock()
    let indexKnown = false
    const bundle = {
      coverage: () => Promise.resolve(indexKnown ? ('none' as const) : ('unknown' as const)),
      get: () => Promise.resolve(null),
    }
    const asked: string[] = []
    const network = { get: (id: string) => (asked.push(id), Promise.resolve(null)) }
    const drive = askOnce({ tiles: createTileSource({ bundle, cache: memoryTileStore(), network, now: clock.now }) })
    for (let check = 0; check < 5; check++) {
      expect((await drive.tiles.load([EAST])).awaitingBundle).toEqual([EAST])
      clock.advance(60_000)
    }
    expect(asked).toEqual([])
    indexKnown = true
    for (let check = 0; check < 30; check++) {
      const loaded = await drive.tiles.load([EAST])
      expect(loaded.missing).toEqual([EAST])
      expect(loaded.awaitingBundle).toEqual([])
      clock.advance(60_000)
    }
    expect(asked).toEqual([EAST])
  })
})

describe('fetchFreshRoutes: one check, and the current path asked for when it is missing', () => {
  /** No signal data at all: this is about the Directions requests. */
  const signalSources: SignalSources = {
    tiles: { load: (ids) => Promise.resolve({ tiles: new Map(), missing: [...ids], partial: new Map(), awaitingBundle: [] }) },
  }
  /** A Directions body for routes of the made-up network. */
  const body = (routes: readonly RouteCandidate[]) => ({
    code: 'Ok',
    routes: routes.map((r) => ({ duration: r.durationSec, duration_typical: r.typicalDurationSec ?? r.durationSec, distance: r.distanceM, geometry: { type: 'LineString', coordinates: r.geometry } })),
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

  it('a via point that will not snap to a road (NoSegment) is no answer, so it never adds up to a switch (#52)', async () => {
    const onlyB = body([candidate('B', here, 1450)!])
    expect(await ask(server(onlyB, { code: 'NoSegment', routes: [] }).fetchImpl)).toMatchObject({ ok: true, baseline: null, requests: 2 })
    // The via points are fixed places, so the same point fails every check. It used to count as
    // "no route that way", and three checks switched with no saving ("the road ahead looks closed").
    let state = INITIAL_REROUTE_STATE
    for (let check = 0; check < 6; check++) {
      const result = await ask(server(onlyB, { code: 'NoSegment', routes: [] }).fetchImpl)
      if (!result.ok) throw new Error('expected routes')
      const decision = decideReroute(state, { nowSec: 60 * check, route: driven, positionAlongM: 3000, speedMps: 15, candidates: result.candidates, baseline: result.baseline })
      expect(decision).toMatchObject({ action: 'stay', code: 'route-unconfirmed' })
      expect(decision.nextState.lostPolls).toBe(0)
      state = decision.nextState
    }
  })
  describe('side-street probes (#5)', () => {
    const probes = (allowed = 1, extra: { timeoutMs?: number } = {}) => ({ route: driven, alongM: 3000, allowed, memory: INITIAL_CHECK_PROBES, ...extra })
    /** A is held up (5 minutes over its typical time), so the check probes. */
    const heldUpA = () => candidate('A', here, 1500, { typicalDurationSec: 1200 })!
    const offered = () => body([heldUpA(), candidate('B', here, 1450)!])
    const viaKind = (url: URL) => (url.searchParams.get('radiuses') !== null ? 'probe' : url.searchParams.has('waypoints') ? 'path' : 'routes')

    it('a probe from the car with its heading, through the via with its radius; a new path joins the fresh routes, with the current path asked the same way', async () => {
      const { fetchImpl, urls } = server(offered(), body([candidate('S', here, 1300)!]), body([heldUpA()]))
      const sent: boolean[] = []
      const result = await ask(fetchImpl, { probes: probes(), onRequest: (probe) => sent.push(probe) })
      expect(urls.map(viaKind)).toEqual(['routes', 'probe', 'path'])
      const probe = urls[1]!
      const points = decodeURIComponent(probe.pathname.split('/').at(-1)!).split(';')
      expect(points).toHaveLength(3)
      expect(probe.searchParams.get('waypoints')).toBe('0;2')
      expect(probe.searchParams.get('radiuses')).toBe('unlimited;250;unlimited')
      expect(probe.searchParams.get('bearings')).toBe('90,45;;')
      expect(probe.searchParams.get('alternatives')).toBe('false')
      // The path check for the probe: through points of the current path where S leaves it, with the heading.
      expect(urls[2]!.searchParams.get('radiuses')).toBeNull()
      expect(urls[2]!.searchParams.get('bearings')).toMatch(/^90,45;(90,45;)+$/)
      // Each request after the first was reported as it went out.
      expect(sent).toEqual([true, false])
      if (!result.ok) throw new Error('expected routes')
      expect(result).toMatchObject({ requests: 3, probeRequests: 1, probesTimedOut: false })
      expect(result.fresh.map((r) => r.source ?? 'provider')).toEqual(['provider', 'provider', 'probe'])
      expect(result.baseline).toHaveLength(1)
      // The via it was asked through goes with it, for the next check.
      const via = points[1]!.split(',').map(Number)
      expect(result.fresh[2]!.via![0]).toBeCloseTo(via[0]!, 6)
      expect(result.fresh[2]!.via![1]).toBeCloseTo(via[1]!, 6)
      // The engine then measures S against the current path asked the same way.
      const decision = decideReroute(INITIAL_REROUTE_STATE, { nowSec: 0, route: driven, positionAlongM: 3000, speedMps: 15, candidates: result.candidates, baseline: result.baseline })
      expect(decision).toMatchObject({ code: 'confirming', considered: { savingSec: 200 } })
    })

    it('a probe that comes back as a known road, fails or finds no road adds nothing and asks nothing more, but still counts', async () => {
      for (const answer of [body([candidate('A', here, 1490)!]), 503, { code: 'NoSegment', routes: [] }, { code: 'NoRoute', routes: [] }]) {
        const { fetchImpl, urls } = server(offered(), answer)
        const result = await ask(fetchImpl, { probes: probes() })
        expect(result).toMatchObject({ ok: true, requests: 2, probeRequests: 1, baseline: null })
        expect(urls).toHaveLength(2)
        if (result.ok) expect(result.fresh).toHaveLength(2)
      }
    })

    it('after a path check already made, the probe uses its answer: no second one', async () => {
      const onlyB = body([candidate('B', here, 1450)!])
      const { fetchImpl, urls } = server(onlyB, body([heldUpA()]), body([candidate('S', here, 1300)!]))
      const result = await ask(fetchImpl, { probes: probes() })
      expect(urls.map(viaKind)).toEqual(['routes', 'path', 'probe'])
      expect(result).toMatchObject({ ok: true, requests: 3, probeRequests: 1 })
      if (result.ok) expect(result.fresh.map((r) => r.source ?? 'provider')).toEqual(['provider', 'probe'])
    })

    it('the probe and its path check have a time limit: past it they are cancelled and the check answers without them', async () => {
      const urls: string[] = []
      const neverAnswers = ((input: RequestInfo | URL, init?: { signal?: AbortSignal }) => {
        urls.push(String(input))
        if (urls.length === 1) return Promise.resolve(new Response(JSON.stringify(offered()), { status: 200 }))
        return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      }) as typeof fetch
      const started = Date.now()
      const result = await ask(neverAnswers, { probes: probes(1, { timeoutMs: 30 }) })
      expect(Date.now() - started).toBeLessThan(2000)
      expect(result).toMatchObject({ ok: true, requests: 2, probeRequests: 1, probesTimedOut: true, baseline: null })
      if (result.ok) expect(result.fresh).toHaveLength(2)
      expect(urls).toHaveLength(2)
    })

    it('without leave, nothing to probe, or a route that is not held up, nothing more is asked; an abort while probing is an abort', async () => {
      const none = server(offered())
      expect(await ask(none.fetchImpl, { probes: probes(0) })).toMatchObject({ ok: true, requests: 1, probeRequests: 0 })
      expect(none.urls).toHaveLength(1)
      const free = server(body([candidate('A', here, 1500)!, candidate('B', here, 1450)!]))
      expect(await ask(free.fetchImpl, { probes: probes() })).toMatchObject({ ok: true, requests: 1, probeRequests: 0 })
      const near = server(body([candidate('A', at(18_000, 0), 400, { typicalDurationSec: 100 })!]))
      expect(await ask(near.fetchImpl, { origin: at(18_000, 0), probes: { ...probes(), alongM: 18_000 } })).toMatchObject({ ok: true, requests: 1, probeRequests: 0 })
      const controller = new AbortController()
      const slow = ((input: RequestInfo | URL) => {
        if (new URL(String(input)).searchParams.has('radiuses')) {
          controller.abort()
          return Promise.reject(new DOMException('aborted', 'AbortError'))
        }
        return Promise.resolve(new Response(JSON.stringify(offered()), { status: 200 }))
      }) as typeof fetch
      expect(await ask(slow, { probes: probes(), signal: controller.signal })).toMatchObject({ ok: false, aborted: true })
    })
  })
})

describe('drive features', () => {
  const car: LngLat = [-80.85, 35.2]
  const route: LngLat[] = [car, [-80.85, 35.1], [-80.86, 35.0]]

  it('draws nothing without a drive', () => {
    expect(driveMarkerFeatures(null)).toEqual({ type: 'FeatureCollection', features: [] })
    expect(driveRouteFeatures([])).toEqual({ type: 'FeatureCollection', features: [] })
  })

  it('gives the route as one line, and the turn-off then the car on top as points', () => {
    const line = driveRouteFeatures(route).features
    expect(line.map((f) => [f.properties.kind, f.geometry.type])).toEqual([['route', 'LineString']])
    expect(line[0]!.geometry.coordinates).toEqual(route)
    const { features } = driveMarkerFeatures({ car, route, alongM: 0, turn: { at: [-80.85, 35.15], pending: true } })
    expect(features.map((f) => [f.properties.kind, f.geometry.type, f.properties.pending])).toEqual([
      ['turn', 'Point', true],
      ['car', 'Point', false],
    ])
    expect(features[1]!.geometry.coordinates).toEqual(car)
  })

  it('leaves out a route with no length and a turn that is not there', () => {
    expect(driveRouteFeatures([car]).features).toEqual([])
    const { features } = driveMarkerFeatures({ car, route: [car], alongM: 0, turn: null })
    expect(features.map((f) => f.properties.kind)).toEqual(['car'])
  })

  it('trims off the share of the line behind the car, on the plane Mapbox measures it on', () => {
    const progress = routeProgress(route)
    const lengthM = alongRouteM(route).at(-1)!
    expect(progress(0)).toBe(0)
    expect(progress(-5)).toBe(0)
    expect(progress(Number.NaN)).toBe(0)
    expect(progress(lengthM)).toBe(1)
    expect(progress(lengthM + 100)).toBe(1)
    // The first leg runs due south (Mercator stretches it a little more than its meters), the
    // second south-west; the share grows with the meters and is 0.5 nowhere near the vertex.
    const firstM = distanceM(route[0]!, route[1]!)
    expect(progress(firstM)).toBeGreaterThan(0.45)
    expect(progress(firstM)).toBeLessThan(0.55)
    const shares = [0.1, 0.3, 0.5, 0.7, 0.9].map((k) => progress(k * lengthM))
    expect([...shares].sort((a, b) => a - b)).toEqual(shares)
    expect(routeProgress([car])(10)).toBe(0)
  })

  it('measures the share on the Mercator plane, as Mapbox does, not in meters', () => {
    // Due south along one meridian, two legs of 0.1 degree: the same meters each, but the
    // northern leg is longer on the Mercator plane, so the vertex between them is past half.
    const meridian: LngLat[] = [[-80.85, 35.2], [-80.85, 35.1], [-80.85, 35.0]]
    const y = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
    const share = routeProgress(meridian)(distanceM(meridian[0]!, meridian[1]!))
    expect(share).toBeCloseTo((y(35.2) - y(35.1)) / (y(35.2) - y(35.0)), 9)
    expect(share).toBeGreaterThan(0.5002)
  })
})
