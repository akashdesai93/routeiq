import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIVE_OPTIONS,
  INITIAL_CHECK_PROBES,
  LIVE_IDLE,
  livePollGate,
  liveStep,
  liveView,
  POSITION_ERROR_MESSAGES,
  REQUEST_TIMED_OUT,
  SPOKEN,
  synthesizeAnnouncements,
  WAKE_LOCK_WARNING,
  type GuidanceStep,
  type LiveEffect,
  type LiveEvent,
  type LiveOptions,
  type LiveState,
  type LngLat,
  type PositionFix,
  type RouteCandidate,
} from '../src/core/index.ts'
import { at, candidate, nameOf, type RouteName } from './helpers/driveWorld.ts'

// The live drive as a state machine, on the made-up road network of helpers/driveWorld.ts
// with a clock counted by hand. No network, no device, no timers: events in, effects out.

const DESTINATION = at(20_000, 0)
const T0 = 1_000_000

type Requested = Extract<LiveEffect, { type: 'request-routes' }>

/** One live drive under test: feeds events, keeps the state, and remembers every effect with its time. */
function session(options: Partial<LiveOptions> = {}) {
  let state: LiveState = LIVE_IDLE
  const effects: { atSec: number; effect: LiveEffect }[] = []
  let nowSec = 0
  const send = (event: LiveEvent) => {
    const step = liveStep(state, event, options)
    state = step.state
    step.effects.forEach((effect) => effects.push({ atSec: nowSec, effect }))
    return step.effects
  }
  const nowMs = () => T0 + nowSec * 1000
  const api = {
    get state() {
      return state
    },
    get nowSec() {
      return nowSec
    },
    nowMs,
    effects,
    send,
    setTime(sec: number) {
      nowSec = sec
    },
    start: (route?: RouteCandidate | null) => send({ type: 'start', nowMs: nowMs(), destination: DESTINATION, route }),
    fix(xM: number, yM = 0, extra: Partial<PositionFix> = {}) {
      const [lng, lat] = at(xM, yM)
      return send({ type: 'fix', nowMs: nowMs(), fix: { lng, lat, accuracyM: 8, speedMps: null, headingDeg: null, timeMs: nowMs(), ...extra } })
    },
    tick: () => send({ type: 'tick', nowMs: nowMs() }),
    answer(routes: readonly RouteCandidate[] | null, message?: string, baseline?: readonly RouteCandidate[] | null) {
      const requests = baseline === undefined ? undefined : 2
      return send({ type: 'routes', nowMs: nowMs(), requestId: state.request!.id, routes, message, baseline, requests })
    },
    requests: () => effects.filter((e): e is { atSec: number; effect: Requested } => e.effect.type === 'request-routes'),
    spoken: () => effects.flatMap((e) => (e.effect.type === 'speak' ? [e.effect.line.text] : [])),
    of: (type: LiveEffect['type']) => effects.filter((e) => e.effect.type === type),
    view: () => liveView(state, nowMs(), options),
  }
  return api
}

/** The routes a query from `xM` meters along the main road returns: A, and others with the given times. */
function routesAt(xM: number, etas: Partial<Record<RouteName, number>>): RouteCandidate[] {
  return (Object.keys(etas) as RouteName[]).map((name) => candidate(name, at(xM, 0), etas[name]!)).filter((c): c is RouteCandidate => c !== null)
}

/**
 * Starts a drive on the main road: Start, a first fix at the origin, the first route.
 * Leaves the session driving at time 0 with one request used.
 */
function driving(options: Partial<LiveOptions> = {}, first: RouteCandidate = candidate('A', at(0, 0), 1300)!) {
  const s = session(options)
  s.start()
  s.fix(0)
  s.answer([first])
  return s
}

/**
 * Drives east along the main road at 15 m/s, a fix every second, from the present time
 * to `untilSec`. Every check that goes out is answered at once by `answer` (the default:
 * the main road alone, still the fastest).
 */
function cruise(
  s: ReturnType<typeof session>,
  untilSec: number,
  answer: (xM: number) => readonly RouteCandidate[] | null = (xM) => routesAt(xM, { A: 1300 }),
  speedMps = 15,
) {
  for (let t = s.nowSec + 1; t <= untilSec; t++) {
    s.setTime(t)
    const xM = speedMps * t
    s.fix(xM)
    s.tick()
    if (s.state.request !== null) s.answer(answer(xM))
  }
}

describe('starting', () => {
  it('has the documented defaults in one place', () => {
    expect(DEFAULT_LIVE_OPTIONS).toMatchObject({
      pollIntervalSec: 60,
      minRequestGapSec: 10,
      stationaryPauseSec: 120,
      maxRequests: 60,
      switchBannerSec: 8,
      requestTimeoutSec: 30,
    })
  })

  it('Start watches the position, holds the screen awake and speaks at once (the tap primes the voice)', () => {
    const s = session()
    const effects = s.start()
    expect(effects.map((e) => e.type)).toEqual(['set-muted', 'prime-speech', 'watch-position', 'acquire-wake-lock'])
    expect(effects[1]).toEqual({ type: 'prime-speech', text: 'RouteIQ started' })
    expect(s.state.status).toBe('locating')
    expect(s.view().statusLine).toBe('Finding your position…')
    // A second tap while it runs does nothing.
    expect(s.start()).toEqual([])
  })

  it('waits for a good fix, then plans a route from it and starts on the best one', () => {
    const s = session()
    s.start()
    s.fix(0, 0, { accuracyM: 120 })
    expect(s.state.status).toBe('locating')
    expect(s.view().warnings).toEqual(['Waiting for a better position fix (within 50 m).'])
    expect(s.requests()).toHaveLength(0)

    s.setTime(2)
    s.fix(3, 4)
    expect(s.state.status).toBe('planning')
    const [asked] = s.requests()
    expect(asked!.effect).toMatchObject({ purpose: 'plan', origin: at(3, 4), headingDeg: null })
    expect(s.state.requestsUsed).toBe(1)
    expect(s.view().warnings).toEqual([])

    // The faster of two is taken, whatever order they come in.
    s.setTime(3)
    const effects = s.answer([candidate('C', at(0, 0), 1400)!, candidate('A', at(0, 0), 1300)!])
    expect(s.state.status).toBe('driving')
    expect(nameOf(s.state.route!)).toBe('A')
    expect(effects[0]).toMatchObject({ type: 'follow-route' })
    expect(s.state.tracking!.alongRouteM).toBeCloseTo(3, 0)
    expect(s.view()).toMatchObject({ remainingSec: expect.closeTo(1300, 0), checkedAgoSec: 0, statusLine: 'Watching for a faster route.' })
  })

  it('a device moving at the first fix sends its heading with the first request', () => {
    const s = session()
    s.start()
    s.fix(0, 0, { speedMps: 12, headingDeg: 91 })
    expect(s.requests()[0]!.effect.headingDeg).toBe(91)
  })

  it('says why when no route can be planned, and lets go of the device', () => {
    const s = session()
    s.start()
    s.fix(0)
    const effects = s.answer(null, 'Could not reach Mapbox.')
    expect(s.state.status).toBe('failed')
    expect(s.state.message).toBe('Could not find a route from here. Could not reach Mapbox.')
    expect(effects.map((e) => e.type)).toEqual(['cancel-request', 'stop-watching', 'release-wake-lock'])
    // An answer nobody asked for changes nothing.
    const before = s.state
    s.send({ type: 'routes', nowMs: s.nowMs(), requestId: 99, routes: [] })
    expect(s.state).toBe(before)
  })
})

describe('the route picked on the plan screen (#66)', () => {
  /** B (a side street here: it leaves the main road at 5 km), as the plan screen's probe found it. */
  const sideStreet = () => candidate('B', at(0, 0), 1250, { source: 'probe' })!
  /** What the provider offers from the main road by itself: never the side street. */
  const offered = (xM: number, a = 1300) => routesAt(xM, { A: a, C: 1320 })

  /**
   * Drives B's first 5 km (the stretch it shares with A) at 15 m/s, answering each check
   * with `answer`: the provider's own routes, and what came back for the current path.
   */
  function cruiseOnB(
    s: ReturnType<typeof session>,
    untilSec: number,
    answer: (xM: number) => { routes: readonly RouteCandidate[]; baseline?: readonly RouteCandidate[] | null },
  ) {
    for (let t = s.nowSec + 1; t <= untilSec; t++) {
      s.setTime(t)
      s.fix(15 * t)
      s.tick()
      if (s.state.request !== null) {
        const { routes, baseline } = answer(15 * t)
        s.answer(routes, undefined, baseline)
      }
    }
  }

  it('Start drives the picked side-street route at once: no request, and the first check a poll interval later', () => {
    const s = session()
    const picked = sideStreet()
    s.start(picked)
    const effects = s.fix(0)
    expect(s.state.status).toBe('driving')
    expect(s.state.route).toBe(picked)
    expect(s.state.picked).toBeNull()
    expect(effects[0]).toEqual({ type: 'follow-route', geometry: picked.geometry })
    expect(s.requests()).toHaveLength(0)
    expect(s.state.requestsUsed).toBe(0)
    expect(s.view()).toMatchObject({ remainingSec: expect.closeTo(1250, 0), checkedAgoSec: 0 })
    cruiseOnB(s, 59, (xM) => ({ routes: offered(xM) }))
    expect(s.requests()).toHaveLength(0)
    cruiseOnB(s, 60, (xM) => ({ routes: offered(xM) }))
    expect(s.requests().map((r) => [r.atSec, r.effect.purpose, r.effect.baseline])).toEqual([[60, 'poll', true]])
  })

  it('the answer of the plan is the last check: "checked N s ago" counts from when the answer of the plan came (#71)', () => {
    const s = session()
    // The trip was planned 40 s before the Start tap.
    s.send({ type: 'start', nowMs: s.nowMs(), destination: DESTINATION, route: sideStreet(), routeFetchedAtMs: s.nowMs() - 40_000 })
    s.fix(0)
    expect(s.state.status).toBe('driving')
    expect(s.view().checkedAgoSec).toBe(40)
    s.setTime(5)
    expect(s.view().checkedAgoSec).toBe(45)
    // The first check comes a poll interval after the plan, not after the Start tap.
    cruiseOnB(s, 19, (xM) => ({ routes: offered(xM) }))
    expect(s.requests()).toHaveLength(0)
    cruiseOnB(s, 20, (xM) => ({ routes: offered(xM) }))
    expect(s.requests().map((r) => [r.atSec, r.effect.purpose])).toEqual([[20, 'poll']])
    expect(s.view().checkedAgoSec).toBe(0)
  })

  it('a plan older than the poll interval is checked at once, and a check alone never switches', () => {
    const s = session()
    s.send({ type: 'start', nowMs: s.nowMs(), destination: DESTINATION, route: sideStreet(), routeFetchedAtMs: s.nowMs() - 600_000 })
    s.fix(0)
    expect(s.view()).toMatchObject({ checkedAgoSec: 600, checking: true })
    // Asked from the first fix on the route.
    expect(s.requests().map((r) => [r.atSec, r.effect.purpose])).toEqual([[0, 'poll']])
    s.setTime(1)
    s.fix(15)
    // Even a much faster route is only a first sighting: confirmation needs the next check too.
    s.answer(offered(15, 800), undefined, [candidate('B', at(15, 0), 1250, { source: 'probe' })!])
    expect(s.state.switches).toEqual([])
    expect(s.state.lastDecision).toMatchObject({ action: 'stay', code: 'confirming' })
  })

  it('without the time of the plan, or with one from the future, the Start tap counts as the last check, as before', () => {
    for (const routeFetchedAtMs of [undefined, null, Number.NaN, 1e15]) {
      const s = session()
      s.send({ type: 'start', nowMs: s.nowMs(), destination: DESTINATION, route: sideStreet(), routeFetchedAtMs })
      s.fix(0)
      expect(s.view().checkedAgoSec, String(routeFetchedAtMs)).toBe(0)
      // And the checks keep their minute: a time from the future must not hold them back.
      cruiseOnB(s, 60, (xM) => ({ routes: offered(xM) }))
      expect(s.requests().map((r) => r.atSec), String(routeFetchedAtMs)).toEqual([60])
    }
    // A drive that asks for its own route (the fix was not on the pick) counts its own answer.
    const s = session()
    s.send({ type: 'start', nowMs: s.nowMs(), destination: DESTINATION, route: sideStreet(), routeFetchedAtMs: s.nowMs() - 40_000 })
    s.fix(2000, 600)
    s.setTime(3)
    s.answer([candidate('A', at(0, 0), 1300)!])
    expect(s.view().checkedAgoSec).toBe(0)
  })

  it('a slower route picked on purpose is driven too, not the fastest', () => {
    const s = session()
    const slower = candidate('C', at(0, 0), 1400)!
    s.start(slower)
    s.fix(0)
    expect(s.state.route).toBe(slower)
    expect(s.requests()).toHaveLength(0)
  })

  it('a picked route with no line to drive is ignored: the drive plans its own', () => {
    const s = session()
    s.start({ ...sideStreet(), geometry: [at(0, 0)] })
    expect(s.state.picked).toBeNull()
    s.fix(0)
    expect(s.requests()[0]!.effect).toMatchObject({ purpose: 'plan' })
  })

  it('a first fix away from the picked route asks for a route from there, as without a pick', () => {
    const s = session()
    s.start(sideStreet())
    s.fix(2000, 600)
    expect(s.state.status).toBe('planning')
    expect(s.requests()[0]!.effect).toMatchObject({ purpose: 'plan', origin: at(2000, 600) })
    s.answer([candidate('A', at(0, 0), 1300)!])
    expect(nameOf(s.state.route!)).toBe('A')
    expect(s.state.picked).toBeNull()
  })

  it("checks that offer only the provider's own routes do not lose the side street", () => {
    const s = session()
    const picked = sideStreet()
    s.start(picked)
    s.fix(0)
    // Five checks: A and C only, and the current path's own time could not be had
    // (not asked or failed: null; or answered with another road).
    let n = 0
    cruiseOnB(s, 320, (xM) => ({ routes: offered(xM), baseline: ++n % 2 === 0 ? null : offered(xM) }))
    expect(s.requests()).toHaveLength(5)
    expect(s.state.route).toBe(picked)
    expect(s.state.switches).toEqual([])
    expect(s.spoken()).toEqual([])
    expect(s.state.lastDecision).toMatchObject({ action: 'stay', code: 'route-unconfirmed' })
    // Routes came back, but the side street's own time did not: what they save is unknown, never guessed (#175).
    expect(s.state.lastDecision).toMatchObject({ routes: 2, savingSec: null })
    expect(s.state.engine.lostPolls).toBe(0)
    expect(s.view().offRoute).toBe(false)
  })

  it("with the side street's own time from the via request, it is compared like for like, and kept while it is faster", () => {
    const s = session()
    const picked = sideStreet()
    s.start(picked)
    s.fix(0)
    cruiseOnB(s, 320, (xM) => ({ routes: offered(xM), baseline: [candidate('B', at(xM, 0), 1250 - xM / 15, { source: 'probe' })!] }))
    expect(s.requests()).toHaveLength(5)
    expect(s.state.route).toBe(picked)
    expect(s.state.switches).toEqual([])
    expect(s.state.lastDecision).toMatchObject({ action: 'stay' })
    expect(s.state.lastDecision!.code).not.toBe('route-unconfirmed')
    // The side street's fresh time, from the last check (at 300 s, 4.5 km in), is the one shown.
    expect(s.state.eta!.durationSec).toBeCloseTo(950, 0)
  })

  it('leaves the side street only for a route that saves enough, confirmed, under the usual rules', () => {
    const s = session()
    s.start(sideStreet())
    s.fix(0)
    const own = (xM: number) => [candidate('B', at(xM, 0), 1250, { source: 'probe' })!]
    // The main road becomes 100 s faster than the side street: under the two-minute minimum. Stay.
    cruiseOnB(s, 130, (xM) => ({ routes: offered(xM, 1150), baseline: own(xM) }))
    expect(s.state.switches).toEqual([])
    expect(s.state.lastDecision).toMatchObject({ code: 'saving-too-small' })
    // Then five minutes faster: one check to see it, a second to confirm it, then the switch.
    cruiseOnB(s, 190, (xM) => ({ routes: offered(xM, 950), baseline: own(xM) }))
    expect(s.state.switches).toEqual([])
    expect(s.state.lastDecision).toMatchObject({ code: 'confirming' })
    cruiseOnB(s, 250, (xM) => ({ routes: offered(xM, 950), baseline: own(xM) }))
    expect(s.state.switches).toHaveLength(1)
    // The switch keeps the saving it claimed, for the drive log (#107): 5 minutes, less the drive since.
    expect(s.state.switches[0]).toMatchObject({ code: 'faster-route', savingSec: expect.any(Number) })
    expect(s.state.switches[0]!.savingSec).toBeGreaterThan(120)
    expect(nameOf(s.state.route!)).toBe('A')
  })
})

describe('position problems', () => {
  it('permission denied ends the drive with words that say what to do', () => {
    const s = session()
    s.start()
    const effects = s.send({ type: 'position-error', nowMs: s.nowMs(), kind: 'denied' })
    expect(s.state.status).toBe('failed')
    expect(s.state.message).toBe(POSITION_ERROR_MESSAGES.denied)
    expect(s.state.message).toContain('Location permission was denied')
    expect(s.state.message).toContain('browser settings')
    expect(effects.map((e) => e.type)).toEqual(['cancel-request', 'stop-watching', 'release-wake-lock'])
    expect(s.view().statusLine).toBe(POSITION_ERROR_MESSAGES.denied)
  })

  it('an unavailable position and a timeout are passing notes: the drive keeps trying', () => {
    for (const [kind, words] of [
      ['unavailable', 'not available right now. Still trying'],
      ['timeout', 'No position fix yet. Still trying'],
    ] as const) {
      const s = session()
      s.start()
      expect(s.send({ type: 'position-error', nowMs: s.nowMs(), kind })).toEqual([])
      expect(s.state.status).toBe('locating')
      expect(s.view().warnings[0]).toContain(words)
      // The next good fix clears the note and the drive goes on.
      s.fix(0)
      expect(s.state.status).toBe('planning')
      expect(s.view().warnings).toEqual([])
    }
    // The same while driving: a note, nothing more.
    const d = driving()
    d.send({ type: 'position-error', nowMs: d.nowMs(), kind: 'timeout' })
    expect(d.state.status).toBe('driving')
    expect(d.view().warnings).toEqual([POSITION_ERROR_MESSAGES.timeout])
  })

  it('a page that cannot locate at all says so', () => {
    for (const kind of ['insecure', 'unsupported'] as const) {
      const s = session()
      s.start()
      s.send({ type: 'position-error', nowMs: s.nowMs(), kind })
      expect(s.state).toMatchObject({ status: 'failed', message: POSITION_ERROR_MESSAGES[kind] })
    }
    expect(POSITION_ERROR_MESSAGES.insecure).toContain('HTTPS or localhost')
  })
})

describe('poll cadence', () => {
  it('checks every 60 seconds, from the point on the route with the heading of travel', () => {
    const s = driving()
    cruise(s, 400)
    const polls = s.requests().slice(1)
    expect(polls.map((p) => p.atSec)).toEqual([60, 120, 180, 240, 300, 360])
    expect(polls.every((p) => p.effect.purpose === 'poll')).toBe(true)
    // Asked from the car's place on the road (east of the start), heading east.
    expect(polls[0]!.effect.origin[0]).toBeCloseTo(at(900, 0)[0], 5)
    expect(polls[0]!.effect.headingDeg).toBeCloseTo(90, 0)
    expect(s.state.requestsUsed).toBe(7)
    expect(s.state.lastDecision).toMatchObject({ action: 'stay', code: 'no-alternative' })
    expect(s.view().statusLine).toBe('Staying: no other route available right now')
    expect(s.view().checkedAgoSec).toBe(40)
  })

  it('never faster than every 10 seconds, whatever the setting', () => {
    const s = driving({ pollIntervalSec: 2 })
    cruise(s, 100)
    const times = s.requests().map((p) => p.atSec)
    expect(times).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    expect(livePollGate(s.state, s.nowMs() + 9_000, { pollIntervalSec: 2 })).toBe('request-gap')
  })

  it('waits for the answer of one check before sending another', () => {
    // A long request time limit, so the checks of seconds 120 and 180 fall due while it is out
    // (past the limit: see "a request that never answers").
    const s = driving({ requestTimeoutSec: 300 })
    for (let t = 1; t <= 200; t++) {
      s.setTime(t)
      s.fix(15 * t)
      s.tick()
    }
    // The check of second 60 was not answered: no other was sent.
    expect(s.requests().map((p) => p.atSec)).toEqual([0, 60])
    expect(livePollGate(s.state, s.nowMs())).toBe('in-flight')
    expect(s.view().checking).toBe(true)
  })

  it('pauses while standing still for more than two minutes, and checks again at once when moving', () => {
    const s = driving()
    cruise(s, 30)
    // Stopped at 450 m from second 31 on.
    for (let t = 31; t <= 400; t++) {
      s.setTime(t)
      s.fix(450 + (t % 2))
      s.tick()
      if (s.state.request !== null) s.answer(routesAt(450, { A: 1300 }))
    }
    // Checks went on for the first two minutes of the stop, then stopped.
    const duringStop = s.requests().map((p) => p.atSec).filter((t) => t > 30)
    expect(duringStop).toEqual([60, 120])
    expect(livePollGate(s.state, s.nowMs())).toBe('stationary')
    expect(s.view().statusLine).toBe('Standing still: checks are paused until you move.')
    // Off again: the first check goes out as soon as the car is seen moving.
    for (let t = 401; t <= 420; t++) {
      s.setTime(t)
      s.fix(450 + 15 * (t - 400))
      s.tick()
      if (s.state.request !== null) s.answer(routesAt(450 + 15 * (t - 400), { A: 1300 }))
    }
    const after = s.requests().map((p) => p.atSec).filter((t) => t > 400)
    expect(after).toHaveLength(1)
    expect(after[0]).toBeLessThanOrEqual(405)
    // Standing still the heading is not sent: it could point anywhere.
    expect(s.requests().find((p) => p.atSec === 120)!.effect.headingDeg).toBeNull()
  })

  it('does not check from a stale position (a tunnel), and catches up when fixes return', () => {
    const s = driving()
    cruise(s, 45)
    // No fixes from second 46 to 99; the timer keeps going.
    for (let t = 46; t <= 99; t++) {
      s.setTime(t)
      s.tick()
    }
    expect(s.requests().map((p) => p.atSec)).toEqual([0])
    expect(livePollGate(s.state, s.nowMs())).toBe('no-fix')
    expect(s.view().statusLine).toBe('Waiting for a position fix…')
    s.setTime(100)
    s.fix(1500)
    expect(s.requests().map((p) => p.atSec)).toEqual([0, 100])
    expect(s.state.tracking!.alongRouteM).toBeCloseTo(1500, 0)
  })

  it('stops at the request budget and says so', () => {
    const s = driving({ maxRequests: 3 })
    cruise(s, 600)
    expect(s.requests().map((p) => p.atSec)).toEqual([0, 60, 120])
    expect(s.state.requestsUsed).toBe(3)
    expect(livePollGate(s.state, s.nowMs(), { maxRequests: 3 })).toBe('budget-spent')
    expect(s.view()).toMatchObject({
      statusLine: 'Request budget used up (3): driving on without checking for faster routes.',
      requestsUsed: 3,
      maxRequests: 3,
    })
  })
})

describe('a request that never answers (#29)', () => {
  /** Drives at 15 m/s from now to `untilSec` with a fix and a tick every second, answering nothing. */
  function silent(s: ReturnType<typeof session>, untilSec: number) {
    for (let t = s.nowSec + 1; t <= untilSec; t++) {
      s.setTime(t)
      s.fix(15 * t)
      s.tick()
    }
  }

  it('a check that never answers is given up after requestTimeoutSec, and the checks after it still go out', () => {
    const s = driving()
    cruise(s, 59)
    s.setTime(60)
    s.fix(900)
    s.tick()
    expect(s.state.request).toMatchObject({ purpose: 'poll' }) // the fetch now hangs
    const hung = s.state.request!.id
    const before = s.requests().length
    // The repro from #29: 15 minutes of driving with that check never answered.
    for (let t = 61; t <= 960; t++) {
      s.setTime(t)
      s.fix(15 * t)
      s.tick()
      if (s.state.request !== null && s.state.request.id !== hung) s.answer(routesAt(15 * t, { A: 1300 }))
    }
    expect(s.requests().length - before).toBeGreaterThan(0)
    // Cancelled once, 30 s after it was sent, and the next check came at the usual minute.
    expect(s.of('cancel-request').map((e) => e.atSec)).toEqual([90])
    expect(s.requests().map((p) => p.atSec).slice(0, 4)).toEqual([0, 60, 120, 180])
  })

  it('it counts as a failed check: the engine counts it, says why, and nothing else changes', () => {
    const s = driving()
    cruise(s, 59)
    s.setTime(60)
    s.fix(900)
    s.tick()
    const before = s.state
    const hung = s.state.request!.id
    silent(s, 89)
    expect(s.state.request).not.toBeNull()
    expect(s.view().checking).toBe(true)
    s.setTime(90)
    const effects = s.tick()
    expect(effects).toEqual([{ type: 'cancel-request' }])
    expect(s.state.request).toBeNull()
    expect(s.state.engine).toEqual({ ...before.engine, failedPolls: 1 })
    expect(s.state.lastDecision).toMatchObject({ code: 'poll-failed', reason: `Staying: could not check for faster routes (${REQUEST_TIMED_OUT})`, routes: null, savingSec: null })
    expect(s.view()).toMatchObject({ checking: false, statusLine: `Staying: could not check for faster routes (${REQUEST_TIMED_OUT})` })
    expect(s.state.route).toBe(before.route)
    expect(s.state.lastCheckedAtMs).toBe(before.lastCheckedAtMs)
    expect(s.state.requestsUsed).toBe(before.requestsUsed)
    expect(s.spoken()).toEqual([])
    // Its answer, if it ever comes, is ignored: the request it belonged to is gone.
    const followed = s.of('follow-route').length
    s.send({ type: 'routes', nowMs: s.nowMs(), requestId: hung, routes: routesAt(1350, { A: 1300, B: 600 }) })
    expect(s.state.route).toBe(before.route)
    expect(s.of('follow-route')).toHaveLength(followed)
    // Every check hangs: each is a failed poll in a row, and the drive carries on.
    silent(s, 300)
    expect(s.state.engine.failedPolls).toBe(4)
    expect(s.of('cancel-request').map((e) => e.atSec)).toEqual([90, 150, 210, 270])
  })

  it('a timed-out check counts the probes it sent once, and keeps the side street being confirmed', () => {
    const s = driving()
    cruise(s, 59)
    s.setTime(60)
    s.fix(900)
    s.tick()
    const id = s.state.request!.id
    const before = { requests: s.state.requestsUsed, probes: s.state.probes.used }
    // The shell sent the check's path check and one side-street probe, then nothing came back.
    s.send({ type: 'request-sent', requestId: id, probe: false })
    s.send({ type: 'request-sent', requestId: id, probe: true })
    const keep = at(5000, -400)
    const sent = { ...s.state, probes: { ...s.state.probes, keep } }
    expect(sent.requestsUsed).toBe(before.requests + 2)
    expect(sent.probes.used).toBe(before.probes + 1)
    const step = liveStep(sent, { type: 'tick', nowMs: s.nowMs() + 30_000 })
    expect(step.effects[0]).toEqual({ type: 'cancel-request' })
    // Counted as they went out, and not again now.
    expect(step.state.requestsUsed).toBe(before.requests + 2)
    expect(step.state.probes.used).toBe(before.probes + 1)
    // One more check made probes: the next one asks through the next via point.
    expect(step.state.probes.round).toBe(sent.probes.round + 1)
    // A failed check keeps the via being confirmed, as the engine keeps its confirmation.
    expect(step.state.probes.keep).toEqual(keep)
  })

  it('an answer just before the limit is used as usual', () => {
    const s = driving()
    cruise(s, 59)
    s.setTime(60)
    s.fix(900)
    s.tick()
    silent(s, 89)
    s.answer(routesAt(1335, { A: 1300 }))
    expect(s.state.lastDecision!.code).not.toBe('poll-failed')
    expect(s.state.lastCheckedAtMs).toBe(s.nowMs())
    expect(s.state.engine.failedPolls).toBe(0)
    expect(s.of('cancel-request')).toHaveLength(0)
  })

  it('a first route that never comes ends the start with a message, as a failed one does', () => {
    const s = session()
    s.start()
    s.fix(0)
    expect(s.state.status).toBe('planning')
    s.setTime(29)
    s.tick()
    expect(s.state.status).toBe('planning')
    s.setTime(30)
    s.tick()
    expect(s.state.status).toBe('failed')
    expect(s.state.message).toBe(`Could not find a route from here. ${REQUEST_TIMED_OUT}`)
    expect(s.of('cancel-request')).toHaveLength(1)
  })

  it('a search for a new route that hangs is given up, and another is asked for', () => {
    const s = driving()
    cruise(s, 20)
    // Off to the side, square to the road: the car leaves the route.
    for (let t = 21; t <= 40; t++) {
      s.setTime(t)
      s.fix(300, 40 * (t - 20))
      s.tick()
    }
    const replans = () => s.requests().filter((r) => r.effect.purpose === 'replan')
    expect(replans()).toHaveLength(1)
    const sentAt = replans()[0]!.atSec
    for (let t = 41; t <= sentAt + 60; t++) {
      s.setTime(t)
      s.fix(300, 40 * (t - 20))
      s.tick()
    }
    expect(s.of('cancel-request').map((e) => e.atSec)).toContain(sentAt + 30)
    expect(replans().length).toBeGreaterThan(1)
  })

  it('the limit is a setting: a bad value falls back to the default, never to 0', () => {
    for (const requestTimeoutSec of [0, -5, Number.NaN]) {
      const s = driving({ requestTimeoutSec })
      cruise(s, 59)
      s.setTime(60)
      s.fix(900)
      s.tick()
      silent(s, 89)
      expect(s.state.request, String(requestTimeoutSec)).not.toBeNull()
    }
    const s = driving({ requestTimeoutSec: 5 })
    cruise(s, 59)
    s.setTime(60)
    s.fix(900)
    s.tick()
    silent(s, 65)
    expect(s.of('cancel-request').map((e) => e.atSec)).toEqual([65])
  })
})

describe('checks that change nothing', () => {
  it('a failed check leaves the route, the car and the voice alone', () => {
    const s = driving()
    cruise(s, 59)
    const before = s.state
    s.setTime(60)
    s.fix(900)
    expect(s.state.request).not.toBeNull()
    const effects = s.answer(null, 'Could not reach Mapbox.')
    expect(effects).toEqual([])
    expect(s.state.route).toBe(before.route)
    expect(s.state.engine).toEqual({ ...before.engine, failedPolls: 1 })
    expect(s.state.lastDecision).toMatchObject({ code: 'poll-failed', reason: 'Staying: could not check for faster routes (Could not reach Mapbox.)' })
    // No answer, so nothing was seen: no route count and no saving, though the last answer's routes are still kept (#175).
    expect(s.state.lastDecision).toMatchObject({ routes: null, savingSec: null })
    // The last good check is still the last one answered.
    expect(s.state.lastCheckedAtMs).toBe(before.lastCheckedAtMs)
    expect(s.state.candidates).toBe(before.candidates)
    expect(s.spoken()).toEqual([])
    // Several in a row: still nothing, and the next check comes a minute later as usual.
    cruise(s, 190, () => null)
    expect(s.state.engine.failedPolls).toBe(3)
    expect(s.requests().map((p) => p.atSec)).toEqual([0, 60, 120, 180])
    expect(s.spoken()).toEqual([])
  })

  it('staying is never spoken', () => {
    const s = driving()
    // A faster route that saves too little, at every check.
    cruise(s, 320, (xM) => routesAt(xM, { A: 1300, B: 1260 }))
    expect(s.state.lastDecision).toMatchObject({ action: 'stay', code: 'saving-too-small' })
    // The check's own count and like-for-like saving, for the drive diagnostics (#175).
    expect(s.state.lastDecision).toMatchObject({ routes: 2, savingSec: 40 })
    expect(s.state.switches).toEqual([])
    expect(s.spoken()).toEqual([])
    expect(s.view().statusLine).toBe('Staying: faster route saves only 40 seconds')
  })
})

describe('the route being driven is not among the fresh routes', () => {
  it('keeps the route and its guidance, says nothing, and lets the shell ask for the current path', () => {
    const s = driving()
    const route = s.state.route
    // Ten checks in a row come back with B and C only. (The old rule left the route after three.)
    cruise(s, 620, (xM) => routesAt(xM, { B: 1250, C: 1280 }), 5)
    expect(s.state.route).toBe(route)
    expect(s.state.switches).toEqual([])
    expect(s.spoken()).toEqual([])
    expect(s.state.switchBanner).toBeNull()
    expect(s.state.lastDecision).toMatchObject({ action: 'stay', code: 'route-unconfirmed' })
    expect(s.state.tracking!.alongRouteM).toBeCloseTo(3100, -2)
    expect(s.view().offRoute).toBe(false)
    // Every check carried leave for one more request; the first route did not.
    expect(s.requests().map((p) => p.effect.baseline)).toEqual([false, ...Array<boolean>(10).fill(true)])
  })

  it('the answer for the current path is the like-for-like ETA: shown, counted, and what a switch is measured against', () => {
    const s = driving()
    cruise(s, 59)
    s.setTime(60)
    s.fix(900)
    // B alone comes back; asked for the main road itself, the provider says 1200 s. B saves 50 s: stay.
    s.answer(routesAt(900, { B: 1150 }), undefined, routesAt(900, { A: 1200 }))
    expect(s.state.lastDecision).toMatchObject({ action: 'stay', code: 'saving-too-small' })
    expect(s.state.eta).toMatchObject({ durationSec: 1200 })
    // Two requests went into that check.
    expect(s.state.requestsUsed).toBe(3)
    // From now on the main road is five minutes slower than B: confirmed over two checks, then an ordinary switch.
    for (let t = 61; t <= 180; t++) {
      s.setTime(t)
      s.fix(15 * t)
      s.tick()
      if (s.state.request !== null) s.answer(routesAt(15 * t, { B: 1000 }), undefined, routesAt(15 * t, { A: 1300 }))
    }
    expect(s.state.switches).toHaveLength(1)
    expect(s.state.switches[0]).toMatchObject({ code: 'faster-route' })
    expect(s.spoken()).toEqual(['Switching to a faster route. Saves 5 minutes. Turn in 1.4 miles.'])
    expect(s.state.requestsUsed).toBe(7)
  })

  it('leave for the second request ends when the budget has no room for it', () => {
    const s = driving({ maxRequests: 4 })
    cruise(s, 200, (xM) => routesAt(xM, { A: 1300 }))
    // Requests 2 and 3 could each have been followed by one more; the fourth and last could not.
    expect(s.requests().map((p) => p.effect.baseline)).toEqual([false, true, true, false])
  })

  it('asked three times for the road ahead and no route found along it: switches, and says why', () => {
    const s = driving()
    cruise(s, 59)
    for (let t = 60; t <= 180; t++) {
      s.setTime(t)
      s.fix(15 * t)
      s.tick()
      if (s.state.request !== null) s.answer(routesAt(15 * t, { B: 1250 }), undefined, [])
    }
    expect(s.state.switches).toHaveLength(1)
    expect(s.state.switches[0]).toMatchObject({ code: 'route-lost', atMs: s.nowMs() })
    expect(s.spoken()).toEqual(['Switching routes. The road ahead on your route looks closed. Turn in 1.4 miles.'])
    // The banner is the spoken line, word for word (#22).
    expect(s.state.switchBanner).toMatchObject({ text: 'Switching routes. The road ahead on your route looks closed. Turn in 1.4 miles.', canKeep: true, beforeSec: null })
  })
})

describe('switching by itself', () => {
  /** B saves five minutes from the first check on. */
  const faster = (xM: number) => routesAt(xM, { A: 1300, B: 1000 })

  it('a confirmed faster route is switched to, and announced once', () => {
    const s = driving()
    cruise(s, 60, faster)
    // First sighting: confirming. Nothing said, the turn-off marked as pending.
    expect(s.state.lastDecision).toMatchObject({ action: 'stay', code: 'confirming' })
    expect(s.state.turn).toMatchObject({ pending: true })
    expect(s.spoken()).toEqual([])

    cruise(s, 120, faster)
    expect(nameOf(s.state.route!)).toBe('B')
    expect(s.state.switches).toHaveLength(1)
    expect(s.state.switches[0]).toMatchObject({ code: 'faster-route', reason: 'Switching: saves 5 minutes, turn in 1.9 miles' })
    expect(s.spoken()).toEqual(['Switching to a faster route. Saves 5 minutes. Turn in 1.9 miles.'])
    expect(s.state.switchBanner).toMatchObject({ text: 'Switching to a faster route. Saves 5 minutes. Turn in 1.9 miles.', canKeep: true })
    expect(s.state.turn).toMatchObject({ at: at(5000, 0), pending: false })
    // The new route starts where the check was sent from: the car is at its beginning.
    expect(s.state.tracking!.alongRouteM).toBeLessThan(20)
    expect(s.of('follow-route')).toHaveLength(2)
    expect(s.view().remainingSec).toBeCloseTo(1000, -1)

    // On B from here on (same road until 5 km): no second announcement, no second switch.
    cruise(s, 300, (xM) => routesAt(xM, { B: 1000, A: 1300 }))
    expect(s.state.switches).toHaveLength(1)
    expect(s.spoken()).toHaveLength(1)
    // The banner went away by itself after eight seconds.
    expect(s.state.switchBanner).toBeNull()
    expect(s.state.undo).toBeNull()
  })

  it('"Keep previous route" goes back, and the engine does not offer that route again', () => {
    const s = driving()
    cruise(s, 120, faster)
    expect(nameOf(s.state.route!)).toBe('B')
    const previous = s.state.undo!.route
    s.setTime(124)
    s.fix(1860)
    const effects = s.send({ type: 'keep-previous', nowMs: s.nowMs() })
    expect(s.state.route).toBe(previous)
    expect(nameOf(s.state.route!)).toBe('A')
    expect(s.state.tracking!.alongRouteM).toBeCloseTo(1860, 0)
    expect(effects.map((e) => e.type)).toEqual(['follow-route', 'speak'])
    expect(s.spoken().at(-1)).toBe(SPOKEN.keptPrevious)
    expect(s.state).toMatchObject({ switchBanner: null, undo: null, switches: [], declinedSwitches: 1 })
    expect(s.state.lastDecision).toMatchObject({ code: 'kept-previous' })
    // As if the switch had not been made: no cooldown, but B is declined for noReturnSec (600 s).
    expect(s.state.engine.lastSwitchAtSec).toBeNull()
    expect(s.state.engine.declined).toHaveLength(1)
    expect(s.state.engine.declined![0]!.untilSec).toBeCloseTo(724, 0)

    // B stays five minutes faster at every check: it is not taken again while declined.
    cruise(s, 320, faster)
    expect(nameOf(s.state.route!)).toBe('A')
    expect(s.state.lastDecision).toMatchObject({ action: 'stay', code: 'driver-declined' })
    expect(s.state.lastDecision!.reason).toBe('Staying: faster route saves 5 minutes, but you chose to keep this route')
    expect(s.spoken().filter((line) => line.startsWith('Switching'))).toHaveLength(1)
    expect(s.state.switches).toEqual([])
  })

  it('doing nothing accepts: once the banner is gone the button does nothing', () => {
    const s = driving()
    cruise(s, 120, faster)
    cruise(s, 129, faster)
    expect(s.state.switchBanner).toBeNull()
    const before = s.state
    expect(s.send({ type: 'keep-previous', nowMs: s.nowMs() })).toEqual([])
    expect(s.state).toBe(before)
    expect(nameOf(s.state.route!)).toBe('B')
  })

  it('turn prompts are spoken once each, and are re-armed for the new route after a switch', () => {
    /** Guidance for a route of the network: a turn at each of its maneuvers, announced the made-up way. */
    const guided = (c: RouteCandidate): RouteCandidate => {
      const guidance: GuidanceStep[] = c.maneuvers.map((m, i) => ({
        atDistanceM: m.atDistanceM,
        location: m.location,
        type: m.kind,
        modifier: m.kind === 'turn' ? 'left' : null,
        primaryText: `${nameOf(c)} road ${i}`,
        secondaryText: null,
        announcements:
          i === 0 ? [] : synthesizeAnnouncements(m.kind === 'arrive' ? 'Your destination is ahead.' : `Turn onto ${nameOf(c)} road ${i}.`, c.maneuvers[i - 1]!.atDistanceM, m.atDistanceM),
        synthesized: true,
      }))
      return { ...c, guidance }
    }
    const offer = (xM: number, yM: number, etas: Partial<Record<RouteName, number>>) =>
      (Object.keys(etas) as RouteName[]).map((n) => candidate(n, at(xM, yM), etas[n]!)).filter((c): c is RouteCandidate => c !== null).map(guided)

    const s = driving({}, guided(candidate('A', at(0, 0), 1300)!))
    // A has no turn: its only prompts are about arriving, 20 km on.
    expect(s.view().nextTurn).toMatchObject({ arrow: 'arrive', primaryText: 'A road 1' })
    cruise(s, 120, (xM) => offer(xM, 0, { A: 1300, B: 1000 }))
    expect(nameOf(s.state.route!)).toBe('B')
    expect(s.view().nextTurn).toMatchObject({ arrow: 'left', primaryText: 'B road 1' })
    expect(s.view().nextTurn!.distanceM).toBeCloseTo(3200, -2)

    // On to the turn at 5 km, then north along B for a while.
    cruise(s, 333, (xM) => offer(xM, 0, { B: 1000 }))
    for (let t = 334; t <= 396; t++) {
      s.setTime(t)
      s.fix(5000, 15 * (t - 333))
      s.tick()
      if (s.state.request !== null) s.answer(offer(5000, 15 * (t - 333), { B: 900 }))
    }
    expect(s.spoken()).toEqual([
      'Switching to a faster route. Saves 5 minutes. Turn in 1.9 miles.',
      'In 0.4 miles, turn onto B road 1.',
      'Turn onto B road 1.',
      'In 0.4 miles, turn onto B road 2.',
      'Turn onto B road 2.',
    ])
    // Turn prompts carry how far the turn is, for the voice's queue rules.
    const prompts = s.of('speak').map((e) => (e.effect.type === 'speak' ? e.effect.line : null)!)
    expect(prompts[0]).toMatchObject({ priority: 'urgent' })
    expect(prompts[1]).toMatchObject({ priority: 'turn', distanceToManeuverM: expect.closeTo(800, -2) })
    expect(prompts[2]!.distanceToManeuverM).toBeLessThan(100)
  })
})

describe('off the route', () => {
  /** A route from wherever the car is, off the network, straight to the destination. */
  const fromHere = (xM: number, yM: number): RouteCandidate => ({
    ...candidate('A', at(0, 0), 1100)!,
    id: 'replanned',
    geometry: [at(xM, yM), at(xM + 500, yM), at(20_000, 0)],
    maneuvers: [],
  })

  it('one stray fix is not off the route; a sustained excursion replans at once and says so', () => {
    const s = driving()
    cruise(s, 65)
    expect(s.requests().map((p) => p.atSec)).toEqual([0, 60])
    // A single fix 120 m to the side, then back on the road.
    s.setTime(66)
    s.fix(990, 120)
    s.setTime(67)
    s.fix(1005)
    expect(s.spoken()).toEqual([])
    expect(s.requests()).toHaveLength(2)

    // Now a real excursion: three fixes in a row, 120 m off.
    for (const t of [68, 69]) {
      s.setTime(t)
      s.fix(15 * t, 120)
    }
    expect(s.spoken()).toEqual([])
    s.setTime(70)
    const effects = s.fix(1050, 120)
    // Said once, and a new route asked for at once: ten seconds after the last check,
    // not a minute, and from the device's position, not from the route line.
    expect(effects.map((e) => e.type)).toEqual(['speak', 'request-routes'])
    expect(s.spoken()).toEqual(['You are off the route. Finding a new one.'])
    // Marked so that the "New route" line a second later cannot take its place in the voice's queue.
    expect(effects[0]).toMatchObject({ line: { priority: 'urgent', mustHear: true } })
    expect(effects[1]).toMatchObject({ purpose: 'replan', baseline: false })
    const replan = s.requests().at(-1)!
    expect(replan).toMatchObject({ atSec: 70, effect: { purpose: 'replan', origin: at(1050, 120) } })
    expect(s.view()).toMatchObject({ offRoute: true, nextTurn: null, statusLine: 'Off the route. Finding a new one…' })

    // Still off while the request is out: nothing is said or asked twice.
    s.setTime(71)
    expect(s.fix(1065, 120)).toEqual([])

    s.setTime(72)
    const applied = s.answer([fromHere(1050, 120)])
    expect(s.state.route!.id).toBe('replanned')
    expect(s.state.switches.at(-1)).toMatchObject({ code: 'off-route', savingSec: null })
    expect(applied.map((e) => e.type)).toEqual(['follow-route', 'speak'])
    expect(s.spoken().at(-1)).toBe('New route. 18 minutes to your destination.')
    // There is no previous route to keep after leaving it.
    expect(s.state.switchBanner).toMatchObject({ text: s.spoken().at(-1), canKeep: false, beforeSec: null, turnInM: null })
    expect(s.state.switchBanner!.text).toMatch(/^New route\. \d+ minutes to your destination\.$/)
    expect(s.state.undo).toBeNull()
    expect(s.state.tracking!.offFixes).toBe(0)
    expect(s.view().offRoute).toBe(false)
  })

  it('replans even when a check was sent a second ago, dropping that check', () => {
    const s = driving()
    cruise(s, 57)
    for (const t of [58, 59]) {
      s.setTime(t)
      s.fix(15 * t, 150)
    }
    // Back on the line for one fix at second 60, where the minute's check goes out...
    s.setTime(60)
    s.fix(900)
    expect(s.state.request).toMatchObject({ purpose: 'poll' })
    // ...and off again for three.
    for (const t of [61, 62, 63]) {
      s.setTime(t)
      s.fix(15 * t, 150)
    }
    expect(s.state.request).toMatchObject({ purpose: 'replan' })
    const types = s.effects.filter((e) => e.atSec === 63).map((e) => e.effect.type)
    expect(types).toEqual(['speak', 'cancel-request', 'request-routes'])
  })

  it('while still off after a new route (a car park) it asks again only every 30 s, without repeating itself', () => {
    const s = driving()
    cruise(s, 10)
    // Parked-lot wandering 150 m off the road from second 11 on; every answer is a route
    // that starts on the road, so the car stays off it.
    const onRoad = (xM: number) => routesAt(xM, { A: 1250 })
    for (let t = 11; t <= 130; t++) {
      s.setTime(t)
      s.fix(150 + (t % 5) * 3, 150, { speedMps: 3 })
      s.tick()
      if (s.state.request !== null) s.answer(onRoad(150))
    }
    const replans = s.requests().filter((p) => p.effect.purpose === 'replan').map((p) => p.atSec)
    expect(replans[0]).toBe(13)
    replans.forEach((t, i) => {
      if (i > 0) expect(t - replans[i - 1]!).toBeGreaterThanOrEqual(30)
    })
    expect(replans.length).toBeLessThanOrEqual(4)
    expect(s.spoken().filter((line) => line === SPOKEN.offRoute)).toHaveLength(1)
    expect(s.spoken().filter((line) => line.startsWith('New route'))).toHaveLength(1)
    // Back on a road: the excursion is over, and the next one would be announced again.
    s.setTime(131)
    s.fix(200, 0)
    expect(s.state).toMatchObject({ offRouteNotified: false, offRouteReplans: 0 })
  })
})

describe('the page in the background', () => {
  it('records the gap, takes the screen lock again and rechecks routes at once on return', () => {
    const s = driving()
    cruise(s, 70)
    expect(s.requests().map((p) => p.atSec)).toEqual([0, 60])
    s.setTime(71)
    expect(s.send({ type: 'visibility', nowMs: s.nowMs(), hidden: true })).toEqual([])
    // Hidden for 95 seconds. A browser gives few fixes or none; whatever comes, no check goes out.
    for (let t = 72; t <= 165; t += 10) {
      s.setTime(t)
      s.fix(15 * t)
      s.tick()
    }
    expect(s.requests()).toHaveLength(2)
    expect(livePollGate(s.state, s.nowMs())).toBe('hidden')

    s.setTime(166)
    s.fix(15 * 166)
    const effects = s.send({ type: 'visibility', nowMs: s.nowMs(), hidden: false })
    expect(effects.map((e) => e.type)).toEqual(['acquire-wake-lock', 'request-routes'])
    expect(s.state.pausedNote).toMatchObject({ seconds: 95 })
    expect(s.view().warnings).toEqual(['RouteIQ was paused for 95 s while in the background.'])
    expect(s.requests().at(-1)).toMatchObject({ atSec: 166, effect: { purpose: 'poll' } })
    // The note goes away by itself.
    s.answer(routesAt(15 * 166, { A: 1300 }))
    s.setTime(182)
    s.tick()
    expect(s.view().warnings).toEqual([])
  })

  it('rechecks on return even a few seconds after a check, as soon as the request gap allows', () => {
    const s = driving()
    cruise(s, 60)
    s.setTime(61)
    s.send({ type: 'visibility', nowMs: s.nowMs(), hidden: true })
    s.setTime(68)
    s.fix(15 * 68)
    // Back after 7 s: 8 s since the last request, so not yet.
    expect(s.send({ type: 'visibility', nowMs: s.nowMs(), hidden: false }).map((e) => e.type)).toEqual(['acquire-wake-lock'])
    expect(s.state.recheck).toBe(true)
    cruise(s, 75)
    expect(s.requests().map((p) => p.atSec)).toEqual([0, 60, 70])
    expect(s.state.recheck).toBe(false)
  })

  it('a glance away is not mentioned and costs no request', () => {
    const s = driving()
    cruise(s, 30)
    s.send({ type: 'visibility', nowMs: s.nowMs(), hidden: true })
    s.setTime(33)
    const effects = s.send({ type: 'visibility', nowMs: s.nowMs(), hidden: false })
    expect(effects.map((e) => e.type)).toEqual(['acquire-wake-lock'])
    expect(s.state.pausedNote).toBeNull()
    expect(s.state.recheck).toBe(false)
  })

  it('warns in one line when the screen cannot be kept awake, and carries on', () => {
    const s = driving()
    s.send({ type: 'wake-lock', result: 'unavailable' })
    expect(s.view().warnings).toEqual([WAKE_LOCK_WARNING])
    expect(WAKE_LOCK_WARNING).toContain('Keep the screen on yourself')
    expect(s.state.status).toBe('driving')
    s.send({ type: 'wake-lock', result: 'held' })
    expect(s.view().warnings).toEqual([])
  })
})

describe('arriving and ending', () => {
  it('arrival stops tracking, releases the screen and sums the trip up', () => {
    const s = driving()
    cruise(s, 120, (xM) => routesAt(xM, { A: 1300, B: 1000 }))
    expect(s.state.switches).toHaveLength(1)
    // Jump to the end of the drive: the last stretch of B is the main road again.
    s.setTime(1290)
    const last = s.state.route!.geometry.at(-1)! as LngLat
    const effects = s.send({ type: 'fix', nowMs: s.nowMs(), fix: { lng: last[0], lat: last[1], accuracyM: 8, speedMps: 3, headingDeg: 90, timeMs: s.nowMs() } })
    expect(s.state.status).toBe('arrived')
    expect(effects.map((e) => e.type)).toEqual(['cancel-request', 'stop-watching', 'release-wake-lock', 'speak'])
    expect(s.spoken().at(-1)).toBe('You have arrived. Trip time 21 minutes. RouteIQ changed route once.')
    expect(s.state.summary).toMatchObject({ tripSec: 1290, declined: 0, requestsUsed: 3 })
    expect(s.state.summary!.switches.map((x) => x.reason)).toEqual(['Switching: saves 5 minutes, turn in 1.9 miles'])
    // Nothing more happens after arrival.
    s.setTime(1300)
    expect(s.fix(20_000)).toEqual([])
    expect(s.tick()).toEqual([])
  })

  it('End stops everything and forgets the drive, the position included', () => {
    const s = driving()
    cruise(s, 60)
    const effects = s.send({ type: 'end' })
    expect(effects.map((e) => e.type)).toEqual(['cancel-request', 'stop-watching', 'release-wake-lock', 'stop-speaking'])
    expect(s.state).toEqual(LIVE_IDLE)
    expect(s.state.lastFix).toBeNull()
  })

  it('Mute is an effect for the voice and is remembered for the next drive', () => {
    const s = driving()
    expect(s.send({ type: 'mute', muted: true })).toEqual([{ type: 'set-muted', muted: true }])
    s.send({ type: 'end' })
    expect(s.state.muted).toBe(true)
    expect(s.start()[0]).toEqual({ type: 'set-muted', muted: true })
  })
})

describe('stalls and stale answers (#26, #27, #28)', () => {
  it('#26: keep-previous with a check in flight lets checks go on at the poll interval', () => {
    const opts = { pollIntervalSec: 10 }
    const faster = (xM: number) => routesAt(xM, { A: 1300, B: 1000 })
    const s = driving(opts)
    let sentAt: number | null = null
    let t = 0
    // Every answer takes 3 s, so a check is out while the switch banner is still up.
    while (s.state.switches.length === 0 && t < 400) {
      t++
      s.setTime(t)
      s.fix(15 * t)
      s.tick()
      if (s.state.request !== null && sentAt === null) sentAt = t
      if (s.state.request !== null && sentAt !== null && t - sentAt >= 3) {
        s.answer(faster(15 * sentAt))
        sentAt = null
      }
    }
    while (s.state.request === null) {
      t++
      s.setTime(t)
      s.fix(15 * t)
      s.tick()
    }
    expect(s.state.switchBanner).not.toBeNull()
    // The runner aborts the fetch: no 'routes' event will come for it.
    const effects = s.send({ type: 'keep-previous', nowMs: s.nowMs() })
    expect(effects[0]).toEqual({ type: 'cancel-request' })
    expect(s.state.request).toBeNull()
    const before = s.requests().length
    for (let k = t + 1; k <= t + 600; k++) {
      s.setTime(k)
      s.fix(15 * k)
      s.tick()
      if (s.state.request !== null) s.answer(routesAt(15 * k, { A: 1300 }))
    }
    expect(s.requests().length - before).toBeGreaterThan(0)
  })

  it('#27: a replan answered after the car is back on the line does not force an off-route switch', () => {
    const s = driving()
    cruise(s, 65)
    for (const t of [66, 67, 68]) {
      s.setTime(t)
      s.fix(15 * t, 120) // 3 fixes 120 m to the side: replan sent
    }
    expect(s.state.request).toMatchObject({ purpose: 'replan' })
    for (const t of [69, 70]) {
      s.setTime(t)
      s.fix(15 * t, 0) // back on A
    }
    expect(s.state.tracking!.offFixes).toBe(0)
    s.setTime(71)
    s.answer(routesAt(15 * 68, { A: 1300, C: 1290 })) // A itself, and C only 10 s faster
    expect(nameOf(s.state.route!)).toBe('A')
    expect(s.state.switches).toEqual([])
    // The answer went through the usual rules: 10 s is below the minimum saving.
    expect(s.state.lastDecision).toMatchObject({ action: 'stay', code: 'saving-too-small' })
    expect(s.spoken().some((line) => line.startsWith('New route'))).toBe(false)
  })

  it('#28: keep-previous after a route-lost switch waits for the full count again', () => {
    const s = driving()
    cruise(s, 59)
    // The road ahead on A is never found again (baseline: []): lost checks, then a route-lost switch.
    const lost = (t: number) => {
      s.setTime(t)
      s.fix(15 * t)
      s.tick()
      if (s.state.request !== null) s.answer(routesAt(15 * t, { B: 1300, C: 1310 }), undefined, [])
    }
    let t = 60
    while (s.state.switches.length === 0 && t <= 400) lost(t++)
    expect(s.state.switches.map((w) => w.code)).toEqual(['route-lost'])
    s.setTime(t)
    s.fix(15 * t)
    s.send({ type: 'keep-previous', nowMs: s.nowMs() }) // driver keeps A
    expect(nameOf(s.state.route!)).toBe('A')
    // The next lost check after the decline is check 1 of 3, not a second switch.
    const checksBefore = s.requests().length
    const until = t + 200
    for (t = t + 1; s.requests().length === checksBefore && t <= until; t++) lost(t)
    expect(s.requests().length).toBe(checksBefore + 1)
    expect(s.state.switches).toEqual([])
    expect(nameOf(s.state.route!)).toBe('A')
    expect(s.state.lastDecision).toMatchObject({ action: 'stay', code: 'route-unconfirmed' })
    expect(s.state.lastDecision!.reason).toContain('check 1 of 3')
  })
})

describe('side-street probes on the checks (#5)', () => {
  /** S, the side street the provider never offers (500 m south of A from 6 to 14 km), as a check's probe found it. */
  const probed = (xM: number, eta: number) => ({ ...candidate('S', at(xM, 0), eta)!, source: 'probe' as const, via: at(10_000, -500) as LngLat })

  /**
   * Answers the check that is out with the provider's routes and a probe's route, the current path
   * asked through via points as the probe was (the path check a probe needs), and the requests they
   * took. With `sent`, the shell reported the path check and the probe as it sent them.
   */
  function answerWithProbe(s: ReturnType<typeof session>, xM: number, sEta: number, { sent = false, pathCheck = true } = {}) {
    const requestId = s.state.request!.id
    if (sent) {
      s.send({ type: 'request-sent', requestId, probe: true })
      if (pathCheck) s.send({ type: 'request-sent', requestId, probe: false })
    }
    return s.send({
      type: 'routes',
      nowMs: s.nowMs(),
      requestId,
      routes: [...routesAt(xM, { A: 1300 }), probed(xM, sEta)],
      baseline: pathCheck ? [candidate('A', at(xM, 0), 1300)!] : null,
      requests: pathCheck ? 3 : 2,
      probes: 1,
    })
  }

  /** Drives on A at 15 m/s to `untilSec`, answering every check with a probe that found S. */
  function cruiseWithProbes(s: ReturnType<typeof session>, untilSec: number, sEta: number, how: { sent?: boolean; pathCheck?: boolean } = {}) {
    for (let t = s.nowSec + 1; t <= untilSec; t++) {
      s.setTime(t)
      s.fix(15 * t)
      s.tick()
      if (s.state.request !== null) answerWithProbe(s, 15 * t, sEta, how)
    }
  }

  it('each check may make one probe, and says what to ask through and within what time; a search for the first route or a new one may not', () => {
    const s = session()
    s.start()
    s.fix(0)
    expect(s.requests()[0]!.effect).toMatchObject({ purpose: 'plan', probes: { allowed: 0 } })
    s.answer([candidate('A', at(0, 0), 1300)!])
    cruise(s, 60)
    expect(s.requests()[1]!.effect).toMatchObject({
      purpose: 'poll',
      baseline: true,
      probes: { allowed: 1, memory: INITIAL_CHECK_PROBES, budget: { timeoutSec: 8, minDelaySec: 120 } },
    })
    // Off the route: a new route at once, with no probe.
    for (let k = 1; k <= 4; k++) {
      s.setTime(60 + k)
      s.fix(900, 400)
    }
    expect(s.requests().at(-1)!.effect).toMatchObject({ purpose: 'replan', probes: { allowed: 0 } })
  })

  it('probes share the request budget: never the request the path check needs, and none once it is spent', () => {
    // 4 requests: the first route, then checks. The 2nd request may probe (room for it and a path check);
    // the 3rd may not (the 4th is the path check's); the 4th has no room for either.
    const s = driving({ maxRequests: 4 })
    cruise(s, 60)
    cruise(s, 120)
    cruise(s, 180)
    expect(s.requests().map((r) => [r.effect.purpose, r.effect.baseline, r.effect.probes.allowed])).toEqual([
      ['plan', false, 0],
      ['poll', true, 1],
      ['poll', true, 0],
      ['poll', false, 0],
    ])
  })

  it('a side street found by the probes is confirmed through the same via, switched to by the usual rules, and announced as such', () => {
    const s = driving()
    cruiseWithProbes(s, 60, 1000)
    expect(s.state.lastDecision).toMatchObject({ action: 'stay', code: 'confirming' })
    // The probe and its path check count against the budget, and its via is asked first next time.
    expect(s.state.requestsUsed).toBe(4)
    expect(s.state.probes).toEqual({ used: 1, round: 1, keep: at(10_000, -500) })

    cruiseWithProbes(s, 120, 1000)
    expect(s.requests()[2]!.effect.probes.memory.keep).toEqual(at(10_000, -500))
    expect(nameOf(s.state.route!)).toBe('S')
    expect(s.state.route!.source).toBe('probe')
    expect(s.state.switches).toHaveLength(1)
    expect(s.spoken()).toEqual(['Switching to a faster route via side streets. Saves 5 minutes. Turn in 2.6 miles.'])
    expect(s.state.switchBanner).toMatchObject({ text: 'Switching to a faster route via side streets. Saves 5 minutes. Turn in 2.6 miles.', canKeep: true })
    expect(s.state.probes).toEqual({ used: 2, round: 2, keep: null })
  })

  it('without the path check a probe needs, a side street never counts', () => {
    const s = driving()
    cruiseWithProbes(s, 300, 1000, { pathCheck: false })
    expect(s.state.switches).toEqual([])
    expect(s.state.lastDecision).toMatchObject({ code: 'probe-unconfirmed' })
    expect(s.state.probes.keep).toBeNull()
  })

  it('a side street that saves only 60 s is found every check and never switched to', () => {
    const s = driving()
    // Six checks, all before S leaves A at 6 km.
    cruiseWithProbes(s, 360, 1240)
    expect(s.state.switches).toEqual([])
    expect(s.state.lastDecision).toMatchObject({ action: 'stay', code: 'saving-too-small', reason: 'Staying: faster route saves only 60 seconds' })
    expect(s.state.probes.keep).toBeNull()
    expect(s.spoken()).toEqual([])
  })

  it('requests are counted as the shell sends them, once, and those of a check cancelled before its answer still count', () => {
    const s = driving()
    cruiseWithProbes(s, 60, 1000, { sent: true })
    // The check, its probe and the probe's path check: 1 + 3, each counted once.
    expect(s.state.requestsUsed).toBe(4)
    expect(s.state.probes.used).toBe(1)
    // The next check sends a probe, then the car leaves the route: the check is cancelled, its answer never comes.
    cruise(s, 119)
    s.setTime(120)
    s.fix(1800)
    s.tick()
    const id = s.state.request!.id
    s.send({ type: 'request-sent', requestId: id, probe: true })
    for (let k = 1; k <= 4; k++) {
      s.setTime(120 + k)
      s.fix(1800 + 15 * k, 400)
    }
    expect(s.state.request!.purpose).toBe('replan')
    // 4, the cancelled check and its probe, and the search for a new route.
    expect(s.state.requestsUsed).toBe(7)
    expect(s.state.probes.used).toBe(2)
  })
})

describe('a slow answer (#5 review)', () => {
  /** B saves five minutes; it leaves A at 5 km. */
  const faster = (xM: number) => routesAt(xM, { A: 1300, B: 1000 })

  it('a check whose probes ran out of time answers without them, and the checks keep their cadence', () => {
    const s = driving()
    const sentAt: number[] = []
    for (let t = 1; t <= 300; t++) {
      s.setTime(t)
      s.fix(15 * t)
      s.tick()
      if (s.state.request !== null && !sentAt.includes(s.state.request.sentAtMs)) sentAt.push(s.state.request.sentAtMs)
      // The shell answers 8 s after sending (the probe never did; its time limit cancelled it).
      if (s.state.request !== null && s.nowMs() - s.state.request.sentAtMs >= 8000) {
        s.send({ type: 'request-sent', requestId: s.state.request.id, probe: true })
        s.answer(routesAt(15 * t, { A: 1300 }))
      }
    }
    expect(sentAt.map((ms) => (ms - T0) / 1000)).toEqual([60, 120, 180, 240, 300])
  })

  it('the turn-off is judged from where the car is when the answer comes, not where it was asked from', () => {
    // Asked at 4.2 km (B turns off 800 m ahead), answered 30 s later with the car 450 m on: 350 m left, too late.
    const s = driving({ pollIntervalSec: 280 })
    cruise(s, 279, faster)
    s.setTime(280)
    s.fix(15 * 280)
    s.tick()
    expect(s.state.request!.alongM).toBeCloseTo(4200, -1)
    for (let t = 281; t <= 310; t++) {
      s.setTime(t)
      s.fix(15 * t)
    }
    s.answer(faster(4200))
    expect(s.state.lastDecision).toMatchObject({ code: 'too-late' })
    expect(s.state.switches).toEqual([])
  })
})

describe('the switch moment on screen (#84)', () => {
  /** B saves five minutes from the first check on. */
  const faster = (xM: number) => routesAt(xM, { A: 1300, B: 1000 })
  /** The same, with light counts: A full with 12, B full with 10, or B only partly counted. */
  const withLights = (bCoverage: 'full' | 'partial') => (xM: number) =>
    faster(xM).map((c) =>
      nameOf(c) === 'A'
        ? { ...c, signalCount: 12, signalCoverage: 'full' as const }
        : { ...c, signalCount: 10, signalCoverage: bCoverage },
    )

  it('pending: the first sighting says what it would save and what it does to the lights, and nothing is switched', () => {
    const s = driving({}, { ...candidate('A', at(0, 0), 1300)!, signalCount: 12, signalCoverage: 'full' })
    cruise(s, 60, withLights('full'))
    expect(s.state.lastDecision).toMatchObject({ code: 'confirming' })
    expect(s.state.offer).toEqual({ savingSec: 300, lightsDelta: -2, turnInM: expect.any(Number), again: false })
    expect(s.view().moment).toEqual({ stage: 'pending', title: 'Checking a faster route', detail: 'Would save 5 min · 2 fewer lights', canKeep: true })
    expect(nameOf(s.state.route!)).toBe('A')
    expect(s.state.switchBanner).toBeNull()
  })

  it('pending: a partly counted route is never compared on lights', () => {
    const s = driving({}, { ...candidate('A', at(0, 0), 1300)!, signalCount: 12, signalCoverage: 'full' })
    cruise(s, 60, withLights('partial'))
    expect(s.state.offer!.lightsDelta).toBeNull()
    expect(s.view().moment).toMatchObject({ detail: "Would save 5 min · lights: can't compare" })
  })

  it('pending ends when a check finds nothing faster', () => {
    const s = driving()
    cruise(s, 60, faster)
    expect(s.view().moment).toMatchObject({ stage: 'pending' })
    cruise(s, 120)
    expect(s.state.offer).toBeNull()
    expect(s.view().moment).toBeNull()
  })

  it('confirmed: the banner is the spoken line, and the before and after figures differ by exactly the saving said', () => {
    const s = driving()
    cruise(s, 120, faster)
    const banner = s.state.switchBanner!
    expect(banner.text).toBe(s.spoken().at(-1))
    expect(banner).toMatchObject({ atMs: s.nowMs(), afterSec: 1000, beforeSec: 1300 })
    const moment = s.view().moment
    expect(moment).toEqual({
      stage: 'confirmed',
      title: 'Switching to a faster route. Saves 5 minutes. Turn in 1.9 miles.',
      before: { sec: 1300, arriveAtMs: s.nowMs() + 1_300_000 },
      after: { sec: 1000, arriveAtMs: s.nowMs() + 1_000_000 },
      canKeep: true,
    })
    // Once the banner closes, the offer it settled does not come back as "Checking a faster route".
    cruise(s, 129, faster)
    expect(s.state.switchBanner).toBeNull()
    expect(s.view().moment).toBeNull()
  })

  it('confirmed: the turn card holds the distance the line said while the banner shows, then counts down', () => {
    // B with a turn at each of its corners: the first is the turn-off, 5 km along the main road.
    const guided = (c: RouteCandidate): RouteCandidate => ({
      ...c,
      guidance: c.maneuvers.map((m, i) => ({
        atDistanceM: m.atDistanceM,
        location: m.location,
        type: m.kind,
        modifier: m.kind === 'turn' ? 'left' : null,
        primaryText: `${nameOf(c)} road ${i}`,
        secondaryText: null,
        announcements: [],
        synthesized: true,
      })),
    })
    const offer = (xM: number) => faster(xM).map(guided)
    const s = driving()
    cruise(s, 120, offer)
    expect(s.spoken().at(-1)).toMatch(/Turn in 1\.9 miles\.$/)
    expect(s.view().heldTurnText).toBe('1.9 mi')
    // Four seconds on, 60 m nearer: still the figure that was said.
    cruise(s, 124, offer)
    expect(s.view().nextTurn!.distanceM).toBeLessThan(s.state.switchBanner!.turnInM! - 50)
    expect(s.view().heldTurnText).toBe('1.9 mi')
    // The banner has closed: the real distance again.
    cruise(s, 129, offer)
    expect(s.state.switchBanner).toBeNull()
    expect(s.view().heldTurnText).toBeNull()
  })

  it('confirmed: a shared turn before the turn-off keeps its own distance; only the turn-off itself is held', () => {
    const withShared = (xM: number) =>
      faster(xM).map((c) => ({
        ...c,
        guidance: [
          { atDistanceM: 400, location: at(xM + 400, 0), type: 'turn', modifier: 'right', primaryText: 'Shared bend', secondaryText: null, announcements: [], synthesized: true },
          ...c.maneuvers.slice(1).map((m) => ({ atDistanceM: m.atDistanceM, location: m.location, type: m.kind, modifier: 'left', primaryText: 'Turn-off', secondaryText: null, announcements: [], synthesized: true })),
        ],
      }))
    const s = driving()
    cruise(s, 120, withShared)
    expect(s.spoken().at(-1)).toMatch(/Turn in 1\.9 miles\.$/)
    expect(s.view().nextTurn).toMatchObject({ primaryText: 'Shared bend' })
    expect(s.view().nextTurn!.distanceM).toBeLessThan(500)
    expect(s.view().heldTurnText).toBeNull()
  })

  it('pending: an offer while off the route is not shown', () => {
    const s = driving()
    cruise(s, 60, faster)
    expect(s.view().moment).toMatchObject({ stage: 'pending' })
    // Off the line long enough for the tracker to say so (the replan it asks for stays unanswered).
    for (let t = 61; t <= 75; t++) {
      s.setTime(t)
      s.fix(15 * t, 200)
    }
    expect(s.view().offRoute).toBe(true)
    expect(s.view().moment).toBeNull()
  })

  it('pending: an offer that arrives after the car has left the route is not shown, and offers no Keep', () => {
    // The path the reviewer named (#135): a check answered "confirming" once the tracker already
    // says off-route. drive() clears the offer on the first off-route fix; this answer comes after.
    const s = driving()
    cruise(s, 60, faster)
    const offer = s.state.offer!
    for (let t = 61; t <= 75; t++) {
      s.setTime(t)
      s.fix(15 * t, 200)
    }
    expect(s.view().offRoute).toBe(true)
    const late = { ...s.state, offer }
    expect(liveView(late, s.nowMs()).offRoute).toBe(true)
    expect(liveView(late, s.nowMs()).moment).toBeNull()
  })

  it('confirmed: a turn back at the turn-off but farther along (a loop) is not given the spoken distance', () => {
    // B's guidance: its only turn is at the turn-off's place, but 4 km farther along than the
    // turn-off (the road loops back past it). The card must show that turn's own distance.
    const looped = (xM: number) =>
      faster(xM).map((c) => {
        const turnOff = c.maneuvers[1]
        if (nameOf(c) !== 'B' || turnOff === undefined) return c
        return {
          ...c,
          guidance: [
            { atDistanceM: turnOff.atDistanceM + 4000, location: turnOff.location, type: 'turn', modifier: 'left', primaryText: 'Loop', secondaryText: null, announcements: [], synthesized: true },
          ],
        }
      })
    const s = driving()
    cruise(s, 120, looped)
    expect(nameOf(s.state.route!)).toBe('B')
    expect(s.state.switchBanner).not.toBeNull()
    expect(s.view().nextTurn).toMatchObject({ primaryText: 'Loop' })
    expect(s.view().nextTurn!.distanceM).toBeGreaterThan(s.state.switchBanner!.turnInM! + 1000)
    expect(s.view().heldTurnText).toBeNull()
  })

  it('"Keep my route" while pending drops the side-street via being confirmed, so no probe is spent on it', () => {
    const s = driving()
    cruise(s, 60, faster)
    const kept = liveStep({ ...s.state, probes: { ...s.state.probes, keep: at(2000, 300) } }, { type: 'keep-previous', nowMs: s.nowMs() })
    expect(kept.state.probes.keep).toBeNull()
  })

  it('a new offer replaces the calm "kept" banner at once', () => {
    // Checks every 10 s and a 30 s banner, so the next offer comes while "kept" still shows.
    const s = driving({ pollIntervalSec: 10, switchBannerSec: 30 })
    cruise(s, 10, faster)
    expect(s.view().moment).toMatchObject({ stage: 'pending' })
    s.send({ type: 'keep-previous', nowMs: s.nowMs() })
    expect(s.view().moment).toMatchObject({ stage: 'kept' })
    // C turns up at the next check: a different route, not the one turned down.
    cruise(s, 20, (xM) => routesAt(xM, { A: 1300, C: 1000 }))
    expect(s.state.lastDecision).toMatchObject({ code: 'confirming' })
    expect(s.state.kept).toBeNull()
    expect(s.view().moment).toMatchObject({ stage: 'pending', title: 'Checking a faster route' })
  })

  it('a different route offered after one was turned down is a first offer, not "Still faster"', () => {
    const s = driving()
    cruise(s, 60, faster)
    s.send({ type: 'keep-previous', nowMs: s.nowMs() })
    cruise(s, 121, (xM) => routesAt(xM, { A: 1300, C: 1000 }))
    expect(s.state.lastDecision).toMatchObject({ code: 'confirming' })
    expect(s.view().moment).toMatchObject({ stage: 'pending', title: 'Checking a faster route' })
  })

  it('"Keep my route" while pending: nothing to undo, the confirmation is dropped and that route is not taken', () => {
    const s = driving()
    cruise(s, 60, faster)
    s.setTime(62)
    s.fix(930)
    const effects = s.send({ type: 'keep-previous', nowMs: s.nowMs() })
    expect(effects.map((e) => e.type)).toEqual(['speak'])
    expect(s.spoken().at(-1)).toBe(SPOKEN.keptPrevious)
    expect(s.state).toMatchObject({ offer: null, turn: null, declinedSwitches: 1, switches: [] })
    expect(s.state.engine.pending).toBeNull()
    expect(s.state.engine.declined![0]!.untilSec).toBeCloseTo(662, 0)
    expect(s.view().moment).toEqual({
      stage: 'kept',
      title: 'Staying on your route.',
      detail: "Won't offer that route again for 10 min.",
      canKeep: false,
    })
    // B stays five minutes faster: it is never switched to while declined.
    cruise(s, 300, faster)
    expect(nameOf(s.state.route!)).toBe('A')
    expect(s.state.switches).toEqual([])
    expect(s.state.lastDecision).toMatchObject({ code: 'driver-declined' })
    expect(s.state.offer).toBeNull()
  })

  it('"Keep my route" after the switch: the calm banner shows for the banner time, then goes', () => {
    const s = driving()
    cruise(s, 120, faster)
    s.setTime(122)
    s.fix(1830)
    s.send({ type: 'keep-previous', nowMs: s.nowMs() })
    expect(s.view().moment).toMatchObject({ stage: 'kept', title: SPOKEN.keptPrevious })
    cruise(s, 129, faster)
    expect(s.view().moment).toMatchObject({ stage: 'kept' })
    cruise(s, 130, faster)
    expect(s.state.kept).toBeNull()
    expect(s.view().moment).toBeNull()
  })

  it('offered again once the no-return time is up: "Still faster. Checking again."', () => {
    // Slowly (5 m/s), so B's turn-off at 5 km is still ahead twelve minutes on.
    const s = driving()
    cruise(s, 60, faster, 5)
    s.send({ type: 'keep-previous', nowMs: s.nowMs() })
    cruise(s, 659, faster, 5)
    expect(s.state.lastDecision).toMatchObject({ code: 'driver-declined' })
    expect(s.view().moment).toBeNull()
    // Declined until 660 s: the check then sees B again, as a new offer.
    cruise(s, 661, faster, 5)
    expect(s.state.lastDecision).toMatchObject({ code: 'confirming' })
    expect(s.view().moment).toMatchObject({ stage: 'pending', title: 'Still faster. Checking again.', detail: "Would save 5 min · lights: can't compare" })
  })
})
