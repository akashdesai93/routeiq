import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIVE_OPTIONS,
  DEFAULT_TRACKING_OPTIONS,
  LIVE_IDLE,
  livePollGate,
  liveStep,
  liveView,
  type LiveEffect,
  type LiveEvent,
  type LiveState,
  type RouteCandidate,
} from '../src/core/index.ts'
import { createDriveDiagnostics, FIX_GAP_EVENT_MS, TICK_GAP_EVENT_MS } from '../src/device/native/diagnostics.ts'
import { at, candidate } from './helpers/driveWorld.ts'

// Battery (#98): while the car stands still, the iPhone shell holds most fixes back in Swift
// (native/shell/.../RouteIQStillness.swift, its checks in native/shell/.../Tests). The
// web app's drive must not notice: here the same stop is driven twice through the live
// state machine, once with a fix and a tick every second, once with what the shell lets
// through, and what the drive asks for and says is compared.

const SWIFT = readFileSync(new URL('../native/shell/shell-native/ios/Sources/RouteIQNativePlugin/RouteIQStillness.swift', import.meta.url), 'utf8')

/** The shell's defaults, read from the Swift source so the two cannot drift apart unseen. */
function swiftDefaults() {
  const m = /defaultOptions = Options\(stillSpeedMps: ([\d.]+), stillRadiusM: ([\d.]+), holdAfterSec: ([\d.]+), keepAliveSec: ([\d.]+), tickQuietSec: ([\d.]+)\)/.exec(SWIFT)
  if (m === null) throw new Error('RouteIQStillness.defaultOptions not found in the Swift source')
  return { stillSpeedMps: Number(m[1]), stillRadiusM: Number(m[2]), holdAfterSec: Number(m[3]), keepAliveSec: Number(m[4]), tickQuietSec: Number(m[5]) }
}

/**
 * When the shell passes fixes on while parked: Core Location's fixes come about once a
 * second (here every `gpsSec`, not a whole second), and a held one is let through by the
 * first fix at least keepAliveSec after the last one passed on.
 */
function parkedSchedule(seconds: number, gpsSec: number): number[] {
  const { holdAfterSec, keepAliveSec } = swiftDefaults()
  const sent: number[] = []
  for (let t = 0; t <= seconds; t += gpsSec) {
    const last = sent.at(-1)
    if (t < holdAfterSec || last === undefined || t - last >= keepAliveSec) sent.push(t)
  }
  return sent
}

const DESTINATION = at(20_000, 0)
const T0 = 1_000_000
const route = (xM: number): RouteCandidate[] => [candidate('A', at(xM, 0), 1300)!]

/**
 * A drive along the main road at 15 m/s that stops at 450 m from `stopSec` to 400 s, then
 * drives on. `thinned`: while standing still, only what the shell passes on: every fix
 * for the first holdAfterSec, then one fix every keepAliveSec and nothing in between (the
 * keep-alive fixes are the clock; RouteIQStillness.tick sends no extra tick then).
 */
function drive(thinned: boolean, stopSec = 33) {
  const { holdAfterSec, keepAliveSec } = swiftDefaults()
  let state: LiveState = LIVE_IDLE
  const effects: { atSec: number; effect: LiveEffect }[] = []
  let events = 0
  let t = 0
  const send = (event: LiveEvent) => {
    const step = liveStep(state, event, {})
    state = step.state
    step.effects.forEach((effect) => effects.push({ atSec: t, effect }))
  }
  const nowMs = () => T0 + t * 1000
  const fix = (xM: number, speedMps: number) => {
    const [lng, lat] = at(xM, 0)
    send({ type: 'fix', nowMs: nowMs(), fix: { lng, lat, accuracyM: 8, speedMps, headingDeg: speedMps > 2 ? 90 : null, timeMs: nowMs() } })
  }
  const answer = (xM: number) => {
    if (state.request !== null) send({ type: 'routes', nowMs: nowMs(), requestId: state.request.id, routes: route(xM) })
  }
  send({ type: 'start', nowMs: nowMs(), destination: DESTINATION })
  fix(0, 15)
  answer(0)
  let lastSent = -Infinity
  /** The poll gate at every second from 200 s (over a poll interval after the last check of the stop) to 400 s. */
  const parkedGates = new Set<string>()
  let statusAt400 = ''
  for (t = 1; t <= 460; t++) {
    const stopped = t >= stopSec && t <= 400
    const xM = t < stopSec ? 15 * t : stopped ? 450 : 450 + 15 * (t - 400)
    const held = thinned && stopped && t - stopSec >= holdAfterSec && t - lastSent < keepAliveSec
    if (!held) {
      // A parked phone's position wanders a little: a meter here.
      fix(stopped ? xM + (t % 2) : xM, stopped ? 0 : 15)
      lastSent = t
      // What reaches the web app during the stop: one fix (and, in this model, its tick).
      if (stopped) events++
      send({ type: 'tick', nowMs: nowMs() })
    }
    answer(xM)
    if (t >= 200 && t <= 400) parkedGates.add(livePollGate(state, nowMs()))
    if (t === 400) {
      statusAt400 = liveView(state, nowMs()).statusLine
    }
  }
  const requests = effects.filter((e) => e.effect.type === 'request-routes').map((e) => e.atSec)
  const spoken = effects.flatMap((e) => (e.effect.type === 'speak' ? [e.effect.line.text] : []))
  return { requests, spoken, events, parkedGates: [...parkedGates], statusAt400 }
}

describe('standing still in the iPhone shell (RouteIQStillness)', () => {
  it('keeps the web drive on its own rules: a fix inside maxFixAgeSec, and a stop the tracker calls a stop', () => {
    const d = swiftDefaults()
    // A held fix waits keepAliveSec and up to one more GPS interval (a slow one: 1.5 s).
    expect(d.keepAliveSec + 1.5).toBeLessThan(DEFAULT_LIVE_OPTIONS.maxFixAgeSec)
    expect(d.keepAliveSec + 1.5).toBeLessThan(TICK_GAP_EVENT_MS / 1000)
    expect(d.tickQuietSec).toBeLessThan(TICK_GAP_EVENT_MS / 1000)
    expect(d.stillSpeedMps).toBeLessThan(DEFAULT_TRACKING_OPTIONS.stoppedSpeedMps)
    // Held back only after the stop has gone on longer than a red light's first seconds.
    expect(d.holdAfterSec).toBeGreaterThanOrEqual(10)
  })

  it('a long stop leaves no false "iOS paused the app" lines in Drive diagnostics', () => {
    // Twenty minutes parked, locked, the GPS on: the web side sees only the fixes let through.
    for (const gpsSec of [1, 1.02, 1.3]) {
      let nowMs = 0
      const log = createDriveDiagnostics(() => nowMs)
      log.appState('background')
      log.gps(true)
      for (const t of parkedSchedule(1200, gpsSec)) {
        nowMs = Math.round(t * 1000)
        log.fix()
        log.tick() // the pulse: every event that reaches the page moves the drive's clock (src/device/native/index.ts)
      }
      expect(log.text()).not.toMatch(/no (tick|fix) for/)
      expect(FIX_GAP_EVENT_MS).toBeGreaterThan(TICK_GAP_EVENT_MS)
    }
  })

  it('with most fixes held back while parked, the drive asks and says the same, pauses the same, and checks as soon as the car moves', () => {
    const every = drive(false)
    const held = drive(true)
    // Far fewer events reach the web app over the six-minute stop: about one in three seconds.
    expect(every.events).toBe(368)
    expect(held.events).toBeLessThan(every.events * 0.4)
    // The checks of the first two minutes of the stop: as many, each at most keepAliveSec late.
    const during = (r: number[]) => r.filter((s) => s > 33 && s <= 400)
    expect(during(held.requests)).toHaveLength(during(every.requests).length)
    expect(during(every.requests)).toEqual([60, 120])
    during(held.requests).forEach((s, i) => {
      expect(s).toBeGreaterThanOrEqual(during(every.requests)[i]!)
      expect(s - during(every.requests)[i]!).toBeLessThanOrEqual(swiftDefaults().keepAliveSec)
    })
    // Then paused for standing still, not "waiting for a position fix".
    expect(held.parkedGates).toEqual(['stationary'])
    expect(held.statusAt400).toBe(every.statusAt400)
    // Moving off: the first check in the same second as with every fix.
    expect(held.requests.filter((s) => s > 400)).toEqual(every.requests.filter((s) => s > 400))
    expect(held.requests.filter((s) => s > 400).length).toBeGreaterThan(0)
    expect(held.spoken).toEqual(every.spoken)
  })
})
