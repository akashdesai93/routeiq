import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STOP_OPTIONS,
  driveLogCsv,
  driveStops,
  formatWait,
  lightTotals,
  movingSec,
  EMPTY_DRIVE_LOG,
  LIVE_IDLE,
  meterFix,
  observeDrive,
  parseDriveLog,
  predictedParts,
  RECORDER_IDLE,
  recordDrive,
  startStopMeter,
  stopPlace,
  worstLights,
  type DriveRecorder,
  type LightsOf,
  type LiveState,
  type LngLat,
  type RouteCandidate,
  type RouteLights,
  type StopMeter,
  type TrackingState,
} from '../src/core/index.ts'

// Where the driver really stood still (#196, step 1): the spec for the Swift port of
// core/stops.ts. Made-up coordinates on the equator only (0.01° of longitude is about 1.1 km).

const T0 = 1_800_000_000_000
const START: LngLat = [0, 0]
const END: LngLat = [0.02, 0]

function route(id: string, extra: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    id,
    geometry: [START, [0.01, 0], END],
    durationSec: 200,
    typicalDurationSec: null,
    distanceM: 2224,
    signalCount: 1,
    signalCoverage: 'full',
    providerSignalCount: null,
    intersections: null,
    limitedAccessSpansM: [],
    maneuvers: [],
    ...extra,
  } as RouteCandidate
}

/** The live state at `sec` seconds, the car `alongM` meters along `r`, the device reading `speedMps`. */
function at(r: RouteCandidate, sec: number, alongM: number, speedMps: number | null, extra: { offFixes?: number; smoothedMps?: number } = {}): LiveState {
  const timeMs = T0 + sec * 1000
  const tracking = {
    alongRouteM: alongM,
    speedMps: extra.smoothedMps ?? speedMps ?? 0,
    offFixes: extra.offFixes ?? 0,
  } as TrackingState
  return {
    ...LIVE_IDLE,
    status: 'driving',
    destination: END,
    startedAtMs: T0,
    route: r,
    tracking,
    // A new object per call: a new fix.
    lastFix: { lng: 0, lat: 0, accuracyM: 5, speedMps, headingDeg: 90, timeMs },
  }
}

const lights = (alongM: number[], coverage: RouteLights['coverage'] = 'full'): LightsOf => () => ({ alongM, coverage })
const NONE: LightsOf = () => undefined

/** Drives `r` at 20 m/s from `fromSec`, one fix a second, to `toSec`. */
function cruise(meter: StopMeter, r: RouteCandidate, fromSec: number, toSec: number, fromM: number, lightsOf: LightsOf = NONE): StopMeter {
  let m = meter
  for (let s = fromSec; s <= toSec; s++) m = meterFix(m, at(r, s, fromM + (s - fromSec) * 20, 20), T0 + s * 1000, lightsOf)
  return m
}

/** Stands still at `alongM` from `fromSec` to `toSec` (one fix a second, device speed 0). */
function wait(meter: StopMeter, r: RouteCandidate, fromSec: number, toSec: number, alongM: number, lightsOf: LightsOf = NONE, speedMps = 0): StopMeter {
  let m = meter
  for (let s = fromSec; s <= toSec; s++) m = meterFix(m, at(r, s, alongM, speedMps), T0 + s * 1000, lightsOf)
  return m
}

const final = (m: StopMeter, r: RouteCandidate, sec: number, alongM: number, lightsOf: LightsOf = NONE, switched = false) =>
  driveStops(m, at(r, sec, alongM, 20), T0 + sec * 1000, lightsOf, 'arrived', switched)

describe('stops', () => {
  it('the defaults', () => {
    expect(DEFAULT_STOP_OPTIONS).toEqual({ crawlSpeedMps: 1.5, minStopSec: 5, lightAheadM: 80, lightBehindM: 25, maxStopsKept: 100, maxUnplacedShare: 0.1, drivenRoundM: 100 })
  })

  it('a wait at a light is kept with its length, its place and the meters driven before it, and the totals add up', () => {
    const r = route('r1')
    const at520 = lights([520])
    let m = startStopMeter(r, T0)
    m = cruise(m, r, 0, 25, 0, at520) // 500 m by second 25
    m = wait(m, r, 26, 65, 500, at520) // stopped from 26; moves off at 66
    m = cruise(m, r, 66, 80, 500, at520)
    m = wait(m, r, 81, 92, 800, at520) // a stop mid-block, far from the light
    m = cruise(m, r, 93, 100, 800, at520)
    const stops = final(m, r, 100, 940, at520)
    expect(stops.list).toEqual([
      { atSec: 26, durationSec: 40, drivenM: 500, place: 'light', road: 'surface' },
      { atSec: 81, durationSec: 12, drivenM: 800, place: 'none', road: 'surface' },
    ])
    expect(stops).toMatchObject({ count: 2, stoppedSec: 52, lightStops: 1, lightSec: 40, unknownStops: 0 })
    expect(stops.stoppedSec).toBe(stops.list.reduce((t, s) => t + s.durationSec, 0))
  })

  it('a stop shorter than minStopSec is not one; minStopSec itself is', () => {
    const r = route('r1')
    let m = cruise(startStopMeter(r, T0), r, 0, 10, 0)
    m = wait(m, r, 11, 14, 200) // 11..14, moves at 15: 4 s
    m = cruise(m, r, 15, 30, 200)
    m = wait(m, r, 31, 35, 520) // 31..35, moves at 36: 5 s
    m = cruise(m, r, 36, 40, 520)
    expect(final(m, r, 40, 600).list.map((s) => s.durationSec)).toEqual([5])
  })

  it('crawling under a walking pace counts as waiting; just over it does not', () => {
    const r = route('r1')
    const crawl = (mps: number) => {
      let m = cruise(startStopMeter(r, T0), r, 0, 10, 0)
      m = wait(m, r, 11, 40, 200, NONE, mps)
      m = cruise(m, r, 41, 45, 240)
      return final(m, r, 45, 340).count
    }
    expect(crawl(1.4)).toBe(1)
    expect(crawl(1.6)).toBe(0)
  })

  it("reads the device's own speed before the smoothed one, which lags behind a stop", () => {
    const r = route('r1')
    let m = cruise(startStopMeter(r, T0), r, 0, 10, 0)
    // The device says 0 at once; the smoothed speed is still at 8 m/s.
    for (let s = 11; s <= 20; s++) m = meterFix(m, at(r, s, 200, 0, { smoothedMps: 8 }), T0 + s * 1000, NONE)
    m = cruise(m, r, 21, 25, 200)
    expect(final(m, r, 25, 300).list[0]).toMatchObject({ atSec: 11, durationSec: 10 })
    // No device speed: the smoothed one is used.
    let n = cruise(startStopMeter(r, T0), r, 0, 10, 0)
    for (let s = 11; s <= 20; s++) n = meterFix(n, at(r, s, 200, null, { smoothedMps: 0.5 }), T0 + s * 1000, NONE)
    n = cruise(n, r, 21, 25, 200)
    expect(final(n, r, 25, 300).list[0]).toMatchObject({ atSec: 11, durationSec: 10 })
  })

  it('the light is matched from where the car stood, not from where the next fix finds it moving', () => {
    const r = route('r1')
    const at520 = lights([520])
    let m = cruise(startStopMeter(r, T0), r, 0, 25, 0, at520)
    m = wait(m, r, 26, 45, 500, at520)
    // One fix later the car is already 60 m on, past the light.
    m = meterFix(m, at(r, 46, 560, 20), T0 + 46_000, at520)
    expect(final(m, r, 46, 560, at520).list[0]!.place).toBe('light')
  })

  it('stores times to a tenth of a second and meters whole', () => {
    const r = route('r1')
    let m = cruise(startStopMeter(r, T0), r, 0, 10, 0.4)
    for (const [ms, mps] of [[11_333, 0], [20_000, 0], [27_777, 20]] as const) m = meterFix(m, at(r, ms / 1000, 200.456, mps), T0 + ms, NONE)
    expect(final(m, r, 30, 300).list).toEqual([{ atSec: 11.3, durationSec: 16.4, drivenM: 200, place: 'unknown', road: 'surface' }])
  })

  it('a light counts up to lightAheadM ahead of where the car moved off and lightBehindM behind it', () => {
    const near = (lightM: number, coverage: RouteLights['coverage'] = 'full') => stopPlace(500, { alongM: [lightM], coverage })
    expect(near(580)).toBe('light')
    expect(near(581)).toBe('none')
    expect(near(475)).toBe('light')
    expect(near(474)).toBe('none')
  })

  it('unknown is never "not at a light": partial or missing light data, or the car off the route', () => {
    expect(stopPlace(500, { alongM: [], coverage: 'partial' })).toBe('unknown')
    expect(stopPlace(500, { alongM: [], coverage: 'none' })).toBe('unknown')
    expect(stopPlace(500, undefined)).toBe('unknown')
    expect(stopPlace(null, { alongM: [500], coverage: 'full' })).toBe('unknown')
    // A light found in partial data is still a light.
    expect(stopPlace(500, { alongM: [510], coverage: 'partial' })).toBe('light')

    const r = route('r1')
    let m = cruise(startStopMeter(r, T0), r, 0, 10, 0)
    for (let s = 11; s <= 30; s++) m = meterFix(m, at(r, s, 200, 0, { offFixes: 3 }), T0 + s * 1000, lights([200]))
    m = meterFix(m, at(r, 31, 200, 20, { offFixes: 3 }), T0 + 31_000, lights([200]))
    const stops = final(m, r, 31, 200)
    expect(stops.list).toEqual([{ atSec: 11, durationSec: 20, drivenM: null, place: 'unknown', road: 'unknown' }])
    expect(stops).toMatchObject({ lightStops: 0, unknownStops: 1 })
  })

  it('on a tick the same meter comes back, and the lights are asked for once per stop', () => {
    const r = route('r1')
    let asked = 0
    const counting: LightsOf = () => {
      asked++
      return { alongM: [200], coverage: 'full' }
    }
    let m = cruise(startStopMeter(r, T0), r, 0, 10, 0, counting)
    const state = at(r, 11, 200, 0)
    m = meterFix(m, state, T0 + 11_000, counting)
    expect(meterFix(m, state, T0 + 12_000, counting)).toBe(m)
    m = wait(m, r, 12, 40, 200, counting)
    expect(asked).toBe(0)
    m = cruise(m, r, 41, 45, 200, counting)
    expect(asked).toBe(1)
  })

  it('a stop under way is closed on arrival, dropped when End is tapped (parked), and left out of a write mid-drive', () => {
    const r = route('r1')
    let m = cruise(startStopMeter(r, T0), r, 0, 10, 0)
    m = wait(m, r, 11, 30, 200)
    const state = at(r, 30, 200, 0)
    expect(driveStops(m, state, T0 + 30_000, NONE, null, false).count).toBe(0)
    expect(driveStops(m, state, T0 + 30_000, NONE, 'ended', false).count).toBe(0)
    expect(driveStops(m, state, T0 + 30_000, lights([210]), 'arrived', false).list).toEqual([
      { atSec: 11, durationSec: 19, drivenM: 200, place: 'light', road: 'surface' },
    ])
    // Arrived on a route the car has had no fix on yet: its lights are not asked for that stop.
    const other = route('r2', { geometry: [[0.001, 0], END] })
    expect(driveStops(m, { ...state, route: other }, T0 + 30_000, lights([210]), 'arrived', false).list[0]!.place).toBe('unknown')
  })

  it('a drive started while parked does not log the wait before the car sets off', () => {
    const r = route('r1')
    let m = wait(startStopMeter(r, T0), r, 0, 60, 0)
    m = cruise(m, r, 61, 80, 0)
    m = wait(m, r, 81, 90, 400)
    m = cruise(m, r, 91, 95, 400)
    expect(final(m, r, 95, 500).list.map((s) => s.atSec)).toEqual([81])
  })

  it('meters driven are stored to the nearest drivenRoundM, not to the meter', () => {
    const r = route('r1')
    let m = cruise(startStopMeter(r, T0), r, 0, 10, 0)
    m = wait(m, r, 11, 20, 1249)
    m = cruise(m, r, 21, 22, 1249)
    expect(final(m, r, 22, 1300).list[0]!.drivenM).toBe(1200)
  })

  it('the street/freeway split is left out when more than maxUnplacedShare of the time was off the route', () => {
    const r = route('r1')
    const run = (offSec: number) => {
      let m = cruise(startStopMeter(r, T0), r, 0, 100, 0)
      for (let s = 101; s <= 100 + offSec; s++) m = meterFix(m, at(r, s, 2000, 20, { offFixes: 3 }), T0 + s * 1000, NONE)
      return final(m, r, 100 + offSec, 2000).parts
    }
    expect(run(10)).not.toBeNull()
    expect(run(13)).toBeNull()
  })

  it('waits at lights as far as known: unknown when none is known and some places are unknown, a lower bound when some are', () => {
    const base = { list: [], count: 3, stoppedSec: 90, lightSec: 0, lightStops: 0, unknownStops: 0, parts: null }
    expect(lightTotals({ ...base, unknownStops: 3 })).toBeNull()
    expect(lightTotals({ ...base, lightStops: 1, lightSec: 40, unknownStops: 2 })).toEqual({ stops: 1, sec: 40, partial: true })
    expect(lightTotals({ ...base })).toEqual({ stops: 0, sec: 0, partial: false })
    expect(movingSec(600, base)).toBe(510)
  })

  it('lists at most maxStopsKept stops, and the totals still count every one', () => {
    const r = route('r1')
    let m = startStopMeter(r, T0)
    let sec = 0
    for (let k = 0; k < 103; k++) {
      m = meterFix(m, at(r, sec, k * 10, 20), T0 + sec * 1000, NONE)
      m = meterFix(m, at(r, sec + 1, k * 10, 0), T0 + (sec + 1) * 1000, NONE)
      sec += 7 // moves off 6 s later
    }
    const stops = final(m, r, sec, 1030)
    expect(stops.list).toHaveLength(100)
    expect(stops.count).toBe(103)
    expect(stops.stoppedSec).toBe(103 * 6)
  })

  it('meters driven go on across a switch to a new route', () => {
    const a = route('a')
    const b = route('b', { geometry: [[0.005, 0], END] })
    let m = cruise(startStopMeter(a, T0), a, 0, 30, 0) // 600 m on a
    // Switched: the new route starts where the car is.
    m = cruise(m, b, 31, 40, 0)
    m = wait(m, b, 41, 50, 200)
    m = cruise(m, b, 51, 52, 200)
    expect(final(m, b, 52, 240).list[0]!.drivenM).toBe(800)
  })

  it('street against freeway: the time per part, and the first route’s prediction per part from its segment times', () => {
    // 0–1112 m: street, 1112–2224 m: freeway. Segment times 80 s and 60 s.
    const r = route('r1', { limitedAccessSpansM: [[1112, 2224]], segmentTraffic: { congestion: null, durationSec: [80, 60] } })
    expect(predictedParts(r)).toEqual({ surface: 80, freeway: 60 })
    expect(predictedParts({ ...r, segmentTraffic: null })).toBeNull()
    expect(predictedParts({ ...r, limitedAccessSpansM: null })).toBeNull()

    let m = startStopMeter(r, T0)
    // 100 s on the street (with a 30 s wait), then 50 s on the freeway.
    for (let s = 0; s <= 100; s++) m = meterFix(m, at(r, s, Math.min(1100, s * 15), s >= 40 && s < 70 ? 0 : 15), T0 + s * 1000, NONE)
    for (let s = 101; s <= 150; s++) m = meterFix(m, at(r, s, 1120 + (s - 101) * 20, 20), T0 + s * 1000, NONE)
    const stops = final(m, r, 150, 2100)
    expect(stops.parts).toEqual({ surface: { predictedSec: 80, actualSec: 101 }, freeway: { predictedSec: 60, actualSec: 49 } })
    expect(stops.list[0]).toMatchObject({ road: 'surface', durationSec: 30 })
    // A kept switch: the first route's prediction no longer speaks for the drive.
    expect(final(m, r, 150, 2100, NONE, true).parts).toEqual({ surface: { predictedSec: null, actualSec: 101 }, freeway: { predictedSec: null, actualSec: 49 } })
  })

  it('road class unknown on any route of the drive: no street/freeway split at all', () => {
    const a = route('a')
    const b = route('b', { limitedAccessSpansM: null })
    let m = cruise(startStopMeter(a, T0), a, 0, 30, 0)
    m = cruise(m, b, 31, 40, 0)
    m = wait(m, b, 41, 50, 200)
    m = cruise(m, b, 51, 52, 200)
    const stops = final(m, b, 52, 240)
    expect(stops.parts).toBeNull()
    expect(stops.list[0]!.road).toBe('unknown')
  })

  it('the worst lights: the longest waits at lights, at most three', () => {
    const r = route('r1')
    let m = startStopMeter(r, T0)
    const at100: LightsOf = lights([100, 300, 500, 700, 900])
    const waits = [20, 50, 10, 35, 50]
    let sec = 0
    waits.forEach((w, k) => {
      m = cruise(m, r, sec, sec + 10, k * 200 + 80, at100)
      m = wait(m, r, sec + 11, sec + 10 + w, k * 200 + 90, at100)
      sec += 11 + w
    })
    m = cruise(m, r, sec, sec + 2, 880, at100)
    const stops = final(m, r, sec + 2, 920, at100)
    expect(stops.lightStops).toBe(5)
    expect(worstLights(stops).map((s) => s.durationSec)).toEqual([50, 50, 35])
    expect(worstLights(stops)[0]!.atSec).toBeLessThan(worstLights(stops)[1]!.atSec)
  })
})

describe('stops in the drive log', () => {
  const r = route('r1', { segmentTraffic: { congestion: null, durationSec: [100, 100] } })
  const context = () => ({ otherAppSec: null, hourOf: () => 8 })

  function drive(): { recorder: DriveRecorder; written: ReturnType<typeof observeDrive>['write'] } {
    let rec: DriveRecorder = RECORDER_IDLE
    let written: ReturnType<typeof observeDrive>['write'] = null
    const feed = (state: LiveState, sec: number) => {
      const step = observeDrive(rec, state, T0 + sec * 1000, context, {}, lights([520]))
      rec = step.recorder
      if (step.write !== null) written = step.write
    }
    for (let s = 0; s <= 25; s++) feed(at(r, s, s * 20, 20), s)
    for (let s = 26; s <= 65; s++) feed(at(r, s, 500, 0), s)
    for (let s = 66; s <= 150; s++) feed(at(r, s, Math.min(2224, 500 + (s - 66) * 20), 20), s)
    feed({ ...at(r, 151, 2224, 0), status: 'arrived' }, 151)
    return { recorder: rec, written }
  }

  it('an arrived drive is written with its stops, and they add up', () => {
    const { written } = drive()
    expect(written!.outcome).toBe('arrived')
    expect(written!.stops).toMatchObject({ count: 1, stoppedSec: 40, lightStops: 1, lightSec: 40 })
    expect(written!.stops!.list).toEqual([{ atSec: 26, durationSec: 40, drivenM: 500, place: 'light', road: 'surface' }])
    expect(written!.stops!.parts!.surface.predictedSec).toBe(200)
  })

  it('stops are stored with no position, read back as they were, and a record from before stops reads as not measured', () => {
    const { written } = drive()
    const log = recordDrive(EMPTY_DRIVE_LOG, written!)
    const text = JSON.stringify(log)
    expect(text).not.toMatch(/-?\d{1,3}\.\d{4,}/)
    expect(parseDriveLog(JSON.parse(text))).toEqual(log)

    const old = JSON.parse(text) as { drives: Record<string, unknown>[] }
    delete old.drives[0]!.stops
    expect(parseDriveLog(old)!.drives[0]!.stops).toBeNull()

    const damaged = JSON.parse(text) as { drives: { stops: { list: unknown[] } }[] }
    damaged.drives[0]!.stops.list[0] = { atSec: 26, durationSec: -1, drivenM: 500, place: 'light', road: 'surface' }
    expect(parseDriveLog(damaged)!.drives).toHaveLength(0)
  })

  it('the CSV never writes an unknown light wait as 0: blank when unknown, ≥ when partly known', () => {
    const { written } = drive()
    const s = written!.stops!
    const csv = driveLogCsv(
      [
        { ...written!, id: 'd1', startedAtMs: T0 + 1, stops: { ...s, lightStops: 0, lightSec: 0, unknownStops: 1 } },
        { ...written!, id: 'd2', startedAtMs: T0 + 2, stops: { ...s, unknownStops: 1 } },
      ].reduce((l, d) => recordDrive(l, d), EMPTY_DRIVE_LOG),
    ).split('\n')
    expect(csv[1]!.endsWith(',0.7,,')).toBe(true)
    expect(csv[2]!.endsWith(',0.7,≥1,≥0.7')).toBe(true)
  })

  it('a record written at a switch carries the stops so far', () => {
    let rec: DriveRecorder = RECORDER_IDLE
    const feed = (state: LiveState, sec: number) => {
      const step = observeDrive(rec, state, T0 + sec * 1000, context, {}, lights([520]))
      rec = step.recorder
      return step.write
    }
    for (let s = 0; s <= 25; s++) feed(at(r, s, s * 20, 20), s)
    for (let s = 26; s <= 65; s++) feed(at(r, s, 500, 0), s)
    for (let s = 66; s <= 70; s++) feed(at(r, s, 500 + (s - 66) * 20, 20), s)
    const b = route('r2')
    const written = feed({ ...at(b, 71, 0, 20), switches: [{ atMs: T0 + 71_000, code: 'faster-route', reason: 'Switching', savingSec: 150 }] }, 71)
    expect(written!.outcome).toBe('unfinished')
    expect(written!.stops).toMatchObject({ count: 1, stoppedSec: 40, lightStops: 1 })
  })

  it('the CSV has the time stopped, the stops at lights and the time at lights; blank when not measured', () => {
    const { written } = drive()
    const csv = driveLogCsv(recordDrive(recordDrive(EMPTY_DRIVE_LOG, written!), { ...written!, id: 'd1', startedAtMs: T0 - 1, stops: null })).split('\n')
    expect(csv[0]!.endsWith(',stopped_min,light_stops,light_wait_min')).toBe(true)
    expect(csv[1]!.endsWith(',,,')).toBe(true)
    expect(csv[2]!.endsWith(',0.7,1,0.7')).toBe(true)
  })
})

describe('formatWait', () => {
  it('to the second under ten minutes, to the minute above', () => {
    expect([0, 4.6, 45, 60, 65, 200, 599, 600, 629, 3600, 3720].map(formatWait)).toEqual([
      '0 s',
      '5 s',
      '45 s',
      '1 min',
      '1 min 5 s',
      '3 min 20 s',
      '9 min 59 s',
      '10 min',
      '10 min',
      '1 h',
      '1 h 2 min',
    ])
    expect(formatWait(-1)).toBe('n/a')
  })
})
