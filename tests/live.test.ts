import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIVE_OPTIONS,
  LIVE_IDLE,
  livePollGate,
  liveStep,
  liveView,
  POSITION_ERROR_MESSAGES,
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
    start: () => send({ type: 'start', nowMs: nowMs(), destination: DESTINATION }),
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
    const s = driving()
    for (let t = 1; t <= 200; t++) {
      s.setTime(t)
      s.fix(15 * t)
      s.tick()
    }
    // The check of second 60 was never answered: no other was sent.
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
    expect(s.state.switchBanner).toMatchObject({ text: 'Switched routes: the road ahead looks closed', canKeep: true })
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
    expect(s.state.switchBanner).toMatchObject({ text: 'Switched to a faster route: saves 5 minutes', canKeep: true })
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
    expect(s.state.switches.at(-1)).toMatchObject({ code: 'off-route' })
    expect(applied.map((e) => e.type)).toEqual(['follow-route', 'speak'])
    expect(s.spoken().at(-1)).toBe('New route. 18 minutes to your destination.')
    // There is no previous route to keep after leaving it.
    expect(s.state.switchBanner).toMatchObject({ text: 'New route from here', canKeep: false })
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
