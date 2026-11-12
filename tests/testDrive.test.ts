import { describe, expect, it } from 'vitest'
import {
  alongRouteM,
  DEFAULT_TRACKING_OPTIONS,
  distanceM,
  pointAtDistance,
  trackedRoute,
  trackFix,
  type LngLat,
  type PositionFix,
  type TrackingState,
} from '../src/core/index.ts'
import type { NativeFix, RouteIQNativePlugin } from '../src/device/native/plugin.ts'
import { nativePositionSource } from '../src/device/native/position.ts'
import { simulatedPositionSource } from '../src/device/native/simulated.ts'
import { buildTestDrive, DEFAULT_TEST_DRIVE_OPTIONS, nearestOnLine, type SimulatedRoute, type TestDriveInput } from '../src/drive/testDrive.ts'

// The iPhone app's test drive: the script the made-up car follows (pure), and
// the position source that hands its fixes to the live session. Every
// coordinate here is made up, around a public landmark (Uptown Charlotte).

const START: LngLat = [-80.8431, 35.2271]
const M_PER_DEG_LAT = 111_195
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((START[1] * Math.PI) / 180)
/** A point `eastM` east and `northM` north of the start. */
const at = (eastM: number, northM: number): LngLat => [START[0] + eastM / M_PER_DEG_LNG, START[1] + northM / M_PER_DEG_LAT]

/** Straight south for 5 km. */
const SOUTH: LngLat[] = [at(0, 0), at(0, -1000), at(0, -2500), at(0, -5000)]
/** South for 900 m, then west (a right turn for a car heading south) for 4 km. */
const TURNS_RIGHT: LngLat[] = [at(0, 0), at(0, -900), at(-4000, -900)]

const input = (over: Partial<TestDriveInput> = {}): TestDriveInput => ({
  geometry: SOUTH,
  from: null,
  drivenM: 0,
  eventBegun: false,
  preset: 'wrong-turn',
  multiplier: 1,
  ...over,
})

/**
 * Drives a script the way the native code does (RouteIQSimulation.swift): one
 * position a second along the points, the speed and the stops from the script.
 */
function walk(route: SimulatedRoute, seconds: number): { point: LngLat; speedMps: number }[] {
  const lengthM = alongRouteM(route.points).at(-1) ?? 0
  const steps = [...route.script].sort((a, b) => a.atM - b.atM)
  let speed = route.speedMps
  let alongM = 0
  let stopLeft = 0
  let next = 0
  const out: { point: LngLat; speedMps: number }[] = []
  for (let s = 0; s <= seconds; s++) {
    const before = alongM
    let left = s === 0 ? 0 : 1
    for (;;) {
      while (next < steps.length && steps[next]!.atM <= alongM + 0.001) {
        const step = steps[next++]!
        if (step.speedMps !== undefined) speed = step.speedMps
        if (step.stopSec !== undefined) stopLeft += step.stopSec
      }
      if (left <= 0) break
      if (stopLeft > 0) {
        const used = Math.min(stopLeft, left)
        stopLeft -= used
        left -= used
        continue
      }
      if (speed <= 0 || alongM >= lengthM) break
      const limit = next < steps.length ? Math.min(lengthM, steps[next]!.atM) : lengthM
      const room = limit - alongM
      if (speed * left < room) {
        alongM += speed * left
        left = 0
      } else {
        alongM = limit
        left -= room / speed
      }
    }
    out.push({ point: pointAtDistance(route.points, alongM)!.point, speedMps: alongM - before })
  }
  return out
}

/** The tracker's verdicts for a walked script on `route`, second by second. */
function track(route: readonly LngLat[], walked: { point: LngLat; speedMps: number }[]): TrackingState[] {
  const prepared = trackedRoute(route)
  let state: TrackingState | null = null
  const states: TrackingState[] = []
  walked.forEach(({ point, speedMps }, s) => {
    const fix: PositionFix = { lng: point[0], lat: point[1], accuracyM: 5, speedMps, headingDeg: null, timeMs: s * 1000 }
    state = trackFix(state, prepared, fix)
    if (state !== null) states.push(state)
  })
  return states
}

describe('the test drive script', () => {
  it('"follow the route" is the route itself at cruising speed, with nothing scripted', () => {
    const script = buildTestDrive(input({ preset: 'follow' }))
    expect(script.points).toEqual(SOUTH)
    expect(script.speedMps).toBe(DEFAULT_TEST_DRIVE_OPTIONS.speedMps)
    expect(script.script).toEqual([])
    expect(script.eventAtM).toBeNull()
  })

  it('is the same script every time for the same input', () => {
    for (const preset of ['follow', 'wrong-turn', 'turn-around'] as const) {
      expect(buildTestDrive(input({ preset, multiplier: 3 }))).toEqual(buildTestDrive(input({ preset, multiplier: 3 })))
    }
    // And it does not change what it was given.
    const before = JSON.stringify(SOUTH)
    buildTestDrive(input())
    expect(JSON.stringify(SOUTH)).toBe(before)
  })

  it('the wrong turn comes after a minute of driving and leaves the route for good', () => {
    const script = buildTestDrive(input())
    expect(script.eventAtM).toBeCloseTo(DEFAULT_TEST_DRIVE_OPTIONS.eventAfterM, 6)
    // On the route up to the turn, then a side street square to it, at least 600 m long.
    const turn = script.points.at(-2)!
    const end = script.points.at(-1)!
    expect(nearestOnLine(SOUTH, turn).distanceM).toBeLessThan(1)
    expect(nearestOnLine(SOUTH, turn).alongM).toBeCloseTo(900, 0)
    expect(distanceM(turn, end)).toBeGreaterThanOrEqual(DEFAULT_TEST_DRIVE_OPTIONS.excursionMinM - 1)
    expect(nearestOnLine(SOUTH, end).distanceM).toBeGreaterThan(DEFAULT_TEST_DRIVE_OPTIONS.excursionMinM - 5)
    // The car slows for the turn and picks up again.
    expect(script.script.map((s) => s.speedMps)).toEqual([DEFAULT_TEST_DRIVE_OPTIONS.turnSpeedMps, DEFAULT_TEST_DRIVE_OPTIONS.speedMps])
  })

  it.each([1, 3])('driven at %i× speed, the wrong turn is farther than the off-route threshold for long enough that the tracker calls it', (multiplier) => {
    const script = buildTestDrive(input({ multiplier }))
    const walked = walk(script, 150)
    const states = track(SOUTH, walked)
    const { offRouteM, offRoutePatienceSec } = DEFAULT_TRACKING_OPTIONS

    // Before the turn the car is on the route and is never called off it.
    const turnSec = walked.findIndex((w) => nearestOnLine(SOUTH, w.point).distanceM > 1)
    expect(turnSec).toBeGreaterThan(15)
    expect(states.slice(0, turnSec).every((s) => !s.offRoute && s.distanceFromRouteM < 1)).toBe(true)

    // After it, the car is beyond the threshold for much longer than the tracker's patience, without coming back.
    const firstOff = walked.findIndex((w) => nearestOnLine(SOUTH, w.point).distanceM > offRouteM)
    const off = walked.slice(firstOff)
    expect(off.every((w) => nearestOnLine(SOUTH, w.point).distanceM > offRouteM)).toBe(true)
    const movingOff = off.filter((w) => w.speedMps > 0).length
    expect(movingOff).toBeGreaterThanOrEqual(DEFAULT_TEST_DRIVE_OPTIONS.excursionMinSec - 10)
    expect(movingOff).toBeGreaterThan(offRoutePatienceSec * 3)

    // And the tracker says so within ten seconds of the car crossing the threshold.
    const calledAt = states.findIndex((s) => s.offRoute)
    expect(calledAt).toBeGreaterThanOrEqual(firstOff)
    expect(calledAt - firstOff).toBeLessThanOrEqual(10)
    // The fastest the car goes stays under what the tracker takes a car to do.
    expect(Math.max(...walked.map((w) => w.speedMps))).toBeLessThan(DEFAULT_TRACKING_OPTIONS.maxSpeedMps)
  })

  it('turns off to the left where the route itself goes right at that corner', () => {
    const script = buildTestDrive(input({ geometry: TURNS_RIGHT }))
    const end = script.points.at(-1)!
    // East of the start: the route goes west there.
    expect(end[0]).toBeGreaterThan(START[0])
    const states = track(TURNS_RIGHT, walk(script, 150))
    expect(states.some((s) => s.offRoute)).toBe(true)
  })

  it('"turn around" goes back over the road it came on, after a stop, and then stands', () => {
    const script = buildTestDrive(input({ preset: 'turn-around' }))
    expect(script.eventAtM).toBeCloseTo(900, 6)
    expect(script.script.some((s) => s.stopSec === DEFAULT_TEST_DRIVE_OPTIONS.uTurnStopSec)).toBe(true)
    const walked = walk(script, 200)
    // Never off the road.
    expect(walked.every((w) => nearestOnLine(SOUTH, w.point).distanceM < 1)).toBe(true)
    const along = walked.map((w) => nearestOnLine(SOUTH, w.point).alongM)
    const farthest = Math.max(...along)
    expect(farthest).toBeCloseTo(900, 0)
    // Back by at least 600 m, and standing at the end.
    expect(farthest - along.at(-1)!).toBeGreaterThanOrEqual(DEFAULT_TEST_DRIVE_OPTIONS.excursionMinM - 1)
    expect(walked.at(-1)!.speedMps).toBe(0)
  })

  it('once the wrong turn has begun, the car follows the new route from where it is', () => {
    const from = at(-400, -900)
    const wayBack: LngLat[] = [at(-380, -900), at(-380, -1500), at(0, -1500), at(0, -5000)]
    const script = buildTestDrive(input({ geometry: wayBack, from, drivenM: 1300, eventBegun: true }))
    expect(script.eventAtM).toBeNull()
    expect(script.script).toEqual([])
    expect(script.points[0]).toEqual(from)
    expect(script.points.at(-1)).toEqual(wayBack.at(-1))
    // It joins the new route at the point nearest the car, not at its start.
    expect(nearestOnLine(wayBack, script.points[1]!).distanceM).toBeLessThan(1)
    expect(distanceM(from, script.points[1]!)).toBeLessThan(25)
  })

  it('a new route before the wrong turn keeps the turn where it was: after 900 m driven in all', () => {
    const from = at(0, -500)
    const script = buildTestDrive(input({ from, drivenM: 500 }))
    expect(script.eventAtM).toBeCloseTo(400, 0)
    expect(nearestOnLine(SOUTH, script.points.at(-2)!).alongM).toBeCloseTo(900, 0)
  })

  it('a route too short for a wrong turn is only followed, and a route with no line makes the car stand', () => {
    const short: LngLat[] = [at(0, 0), at(0, -200)]
    expect(buildTestDrive(input({ geometry: short })).points).toEqual(short)
    expect(buildTestDrive(input({ geometry: short })).eventAtM).toBeNull()
    const none = buildTestDrive(input({ geometry: [], from: START }))
    expect(none).toEqual({ points: [START], speedMps: 0, script: [], eventAtM: null })
  })
})

type Listener = (data?: unknown) => void

function fakePlugin(options: { deny?: boolean } = {}) {
  const listeners = new Map<string, Set<Listener>>()
  const calls: string[] = []
  const routes: SimulatedRoute[] = []
  const plugin: RouteIQNativePlugin = {
    startLocation() {
      calls.push('startLocation')
      return options.deny === true ? Promise.reject({ code: 'denied' }) : Promise.resolve({ authorization: 'when-in-use' })
    },
    stopLocation() {
      calls.push('stopLocation')
      return Promise.resolve()
    },
    getCurrentPosition: () => new Promise(() => {}),
    speak: () => Promise.resolve({ finished: true }),
    cancelSpeech: () => Promise.resolve(),
    keepAwake: () => Promise.resolve(),
    httpGet: () => new Promise(() => {}),
    httpCancel: () => Promise.resolve(),
    startSimulatedRoute(route) {
      calls.push('startSimulatedRoute')
      routes.push(route as unknown as SimulatedRoute)
      return Promise.resolve()
    },
    stopSimulatedRoute() {
      calls.push('stopSimulatedRoute')
      return Promise.resolve()
    },
    addListener(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set()
      listeners.set(event, set)
      set.add(listener)
      return Promise.resolve({ remove: async () => void set.delete(listener) })
    },
  } as RouteIQNativePlugin
  const emit = (event: string, data?: unknown) => [...(listeners.get(event) ?? [])].forEach((l) => l(data))
  return { plugin, calls, routes, emit }
}

const simulatedFix = (p: LngLat, speed = 15): NativeFix => ({ lng: p[0], lat: p[1], accuracy: 5, speed, course: 180, simulated: true })

describe('the test drive as a position source', () => {
  it('starts the made-up car standing at its start, then the real GPS to stay alive, and takes only made-up fixes', async () => {
    const { plugin, calls, routes, emit } = fakePlugin()
    const fixes: PositionFix[] = []
    const errors: string[] = []
    let clock = 1000
    const source = simulatedPositionSource(plugin, { origin: START, preset: 'wrong-turn', multiplier: 1 }, () => clock++)
    const stop = source.start(
      (fix) => fixes.push(fix),
      (kind) => errors.push(kind),
    )
    // The simulation is asked for first, and the GPS only once it runs, so no real position can come first.
    expect(calls).toEqual(['startSimulatedRoute'])
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['startSimulatedRoute', 'startLocation'])
    expect(routes[0]).toEqual({ points: [START], speedMps: 0, script: [] })

    // The phone's own position (not marked simulated) is dropped; so is "no position right now" from indoors.
    emit('fix', { lng: -80.9, lat: 35.1, accuracy: 5 })
    emit('locationError', { kind: 'unavailable' })
    expect(fixes).toEqual([])
    expect(errors).toEqual([])
    emit('fix', simulatedFix(START, 0))
    expect(fixes).toHaveLength(1)
    expect(fixes[0]).toMatchObject({ lng: START[0], lat: START[1], accuracyM: 5, timeMs: 1000 })

    // The session's route: the car gets the wrong-turn script for it.
    source.follow!(SOUTH)
    expect(routes[1]!.points[0]).toEqual(START)
    expect(routes[1]!.speedMps).toBe(15)
    expect(routes[1]!.script).toHaveLength(2)

    // It drives past the turn (900 m) and off; the session then hands it the way back, which it simply follows.
    for (let m = 100; m <= 900; m += 100) emit('fix', simulatedFix(at(0, -m)))
    emit('fix', simulatedFix(at(-200, -900)))
    const wayBack: LngLat[] = [at(-200, -900), at(-200, -1500), at(0, -1500), at(0, -5000)]
    source.follow!(wayBack)
    expect(routes[2]!.script).toEqual([])
    expect(routes[2]!.points.at(-1)).toEqual(wayBack.at(-1))

    stop()
    await Promise.resolve()
    expect(calls.slice(-2)).toEqual(['stopLocation', 'stopSimulatedRoute'])
    // Nothing after End.
    emit('fix', simulatedFix(at(0, -1000)))
    expect(fixes).toHaveLength(11)
    expect(errors).toEqual([])
  })

  it('a refused location permission fails the test drive like a real one', async () => {
    const { plugin } = fakePlugin({ deny: true })
    const errors: string[] = []
    simulatedPositionSource(plugin, { origin: START, preset: 'follow', multiplier: 1 }).start(
      () => {},
      (kind) => errors.push(kind),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(errors).toEqual(['denied'])
  })

  it('a real drive never takes a made-up fix for the GPS', () => {
    const { plugin, emit } = fakePlugin()
    const fixes: PositionFix[] = []
    nativePositionSource(plugin).start(
      (fix) => fixes.push(fix),
      () => {},
    )
    emit('fix', simulatedFix(START))
    expect(fixes).toEqual([])
    emit('fix', { lng: START[0], lat: START[1], accuracy: 5 })
    expect(fixes).toHaveLength(1)
  })
})
