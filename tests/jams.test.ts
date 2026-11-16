import { describe, expect, it } from 'vitest'
import {
  corridorJams,
  corridorJamWords,
  DEFAULT_JAM_OPTIONS,
  DRIVE_LOG_CSV_HEADER,
  driveJams,
  driveLogCsv,
  EMPTY_DRIVE_LOG,
  endDrive,
  endJams,
  JAM_RECORDER_IDLE,
  jamWords,
  knownJamSec,
  LIVE_IDLE,
  meterJamFix,
  observeDrive,
  observeJams,
  parseDriveJams,
  parseDriveLog,
  recordDrive,
  roadKindAt,
  startJamMeter,
  type DriveJams,
  type DriveRecord,
  type JamMeter,
  type JamRecorder,
  type LiveState,
  type LngLat,
  type RoadKindSpan,
  type RouteCandidate,
} from '../src/core/index.ts'
import { createDriveDiagnostics, JAM_TOTAL_CAP } from '../src/device/native/diagnostics.ts'

// The jam meter (#227): the spec for the Swift port of core/jams.ts and core/jamLog.ts.

const UPTOWN: LngLat = [-80.8431, 35.2271]
const INDIAN_LAND: LngLat = [-80.8561, 35.0015]
const T0 = 1_800_000_000_000

/** The first 10 km are main road, the next 5 km a side street, then main road again. */
const SPANS: readonly RoadKindSpan[] = [
  { startM: 0, endM: 10_000, kind: 'main' },
  { startM: 10_000, endM: 15_000, kind: 'side' },
  { startM: 15_000, endM: 25_000, kind: 'main' },
]

/** `spans` left out: SPANS. Passed as undefined: the route says nothing about its roads. */
function route(id: string, ...spans: [RouteCandidate['roadKindSpansM']?]): RouteCandidate {
  const roadKindSpansM = spans.length === 0 ? SPANS : spans[0]
  return {
    id,
    geometry: [UPTOWN, INDIAN_LAND],
    durationSec: 1200,
    typicalDurationSec: null,
    distanceM: 25_000,
    signalCount: null,
    signalCoverage: 'none',
    providerSignalCount: null,
    intersections: null,
    limitedAccessSpansM: [],
    roadKindSpansM,
    maneuvers: [],
  }
}
const MAIN = route('route-main')

interface Fix {
  /** The device's speed. Null: it gives none (the smoothed speed is used). */
  readonly speedMps: number | null
  readonly alongM: number
  readonly offRoute?: boolean
  readonly smoothedMps?: number
}

/** The live state of a drive on `r` at one fix. */
function stateAt(r: RouteCandidate, atMs: number, fix: Fix, extra: Partial<LiveState> = {}): LiveState {
  const f = { lng: UPTOWN[0], lat: UPTOWN[1], accuracyM: 5, speedMps: fix.speedMps, headingDeg: 180, timeMs: atMs }
  return {
    ...LIVE_IDLE,
    status: 'driving',
    destination: INDIAN_LAND,
    startedAtMs: T0,
    route: r,
    lastFix: f,
    tracking: {
      fix: f,
      position: UPTOWN,
      alongRouteM: fix.alongM,
      remainingM: r.distanceM - fix.alongM,
      speedMps: fix.smoothedMps ?? fix.speedMps ?? 0,
      headingDeg: 180,
      distanceFromRouteM: fix.offRoute === true ? 200 : 0,
      offRoute: fix.offRoute === true,
      arrived: false,
      stoppedSinceMs: null,
      offSinceMs: fix.offRoute === true ? atMs : null,
      offFixes: 0,
      jumpFixes: 0,
      reversing: false,
      ignoredFixes: 0,
    },
    eta: { durationSec: r.durationSec, remainingM: r.distanceM },
    requestsUsed: 1,
    ...extra,
  }
}

/** A stretch of a scripted drive: `sec` seconds at `mps`, one fix a second. */
type Leg = readonly [sec: number, mps: number]

/**
 * Drives the legs from `fromM` along `r`, one fix a second, starting at T0. The fix at second
 * t carries the speed of the leg that second belongs to. Returns the meter and the time after the last leg.
 */
function drive(legs: readonly Leg[], options: { r?: RouteCandidate; fromM?: number; meter?: JamMeter; fromMs?: number; offRoute?: (sec: number) => boolean } = {}) {
  const r = options.r ?? MAIN
  let meter = options.meter ?? startJamMeter(T0)
  let alongM = options.fromM ?? 0
  let ms = options.fromMs ?? T0
  let sec = 0
  for (const [forSec, mps] of legs) {
    for (let i = 0; i < forSec; i++) {
      meter = meterJamFix(meter, stateAt(r, ms, { speedMps: mps, alongM, offRoute: options.offRoute?.(sec) }), ms)
      alongM += mps
      ms += 1000
      sec++
    }
  }
  return { meter, ms, alongM }
}

/** The jams of a drive that arrives right after its last leg. */
const jamsOf = (legs: readonly Leg[], options: Parameters<typeof drive>[1] = {}): DriveJams => {
  const { meter, ms } = drive(legs, options)
  return driveJams(meter, ms, true)
}

describe('the thresholds', () => {
  it('are these (README, "Jam minutes")', () => {
    expect(DEFAULT_JAM_OPTIONS).toEqual({ jamSpeedMps: 6.7, minJamSec: 30, setOffSpeedMps: 1.5, maxFixGapSec: 15, maxJamsKept: 50, drivenRoundM: 100 })
  })
})

describe('a jam on a main road', () => {
  it('three minutes at 4 m/s is one jam of 3 min, with when it began and the meters driven before it', () => {
    // 2 min at 25 m/s (3 km), the crawl, then on.
    const jams = jamsOf([[120, 25], [180, 4], [60, 25]])
    expect(jams).toEqual({ list: [{ atSec: 120, durationSec: 180, drivenM: 3000 }], count: 1, jamSec: 180, unknownSec: 0 })
    expect(jamWords(jams)).toBe('3 min in 1 jam')
    expect(knownJamSec(jams)).toBe(180)
  })

  it('is under 6.7 m/s: at 6.7 the car is not crawling', () => {
    expect(jamsOf([[60, 25], [120, 6.6], [60, 25]]).count).toBe(1)
    expect(jamsOf([[60, 25], [120, 6.7], [60, 25]])).toEqual({ list: [], count: 0, jamSec: 0, unknownSec: 0 })
  })

  it('lasts 30 s or more: 29 s of slowing down is not a jam', () => {
    expect(jamsOf([[60, 25], [29, 4], [60, 25]]).count).toBe(0)
    const jams = jamsOf([[60, 25], [30, 4], [60, 25]])
    expect([jams.count, jams.jamSec]).toEqual([1, 30])
    expect(jamWords(jams)).toBe('30 s in 1 jam')
  })

  it('a stop inside a jam is part of it; two crawls with free driving between are two jams', () => {
    const one = jamsOf([[60, 25], [40, 4], [50, 0], [40, 3], [60, 25]])
    expect([one.count, one.jamSec]).toEqual([1, 130])
    const two = jamsOf([[60, 25], [40, 4], [10, 25], [200, 3], [60, 25]])
    expect(two.list.map((j) => j.durationSec)).toEqual([40, 200])
    expect([two.count, two.jamSec]).toEqual([2, 240])
    expect(jamWords(two)).toBe('4 min in 2 jams')
  })

  it('the meters driven before a jam are kept to the nearest 100 m, and add up across a change of route', () => {
    // 100 s at 25 m/s = 2500 m, then 49 s more = 3725 m: kept as 3700.
    expect(jamsOf([[149, 25], [60, 4], [10, 25]]).list[0]!.drivenM).toBe(3700)
    // A new route after 2 km: the car is 500 m along it when the crawl begins 20 s later.
    const first = drive([[80, 25]])
    const second = drive([[20, 25], [60, 4], [5, 25]], { r: route('route-other'), meter: first.meter, fromMs: first.ms, fromM: 0 })
    const jams = driveJams(second.meter, second.ms, true)
    // 79 m short of 2 km on the first route (its last fix), 500 m on the second.
    expect(jams.list).toEqual([{ atSec: 100, durationSec: 60, drivenM: 2500 }])
  })

  it('the time between two fixes belongs to the earlier one: a car that stands still and sends no fix is still in its jam', () => {
    let meter = drive([[60, 25]]).meter
    meter = meterJamFix(meter, stateAt(MAIN, T0 + 60_000, { speedMps: 0, alongM: 1500 }), T0 + 60_000)
    // No fix for 90 s (fixes are held back while the car stands still), then it drives on.
    meter = meterJamFix(meter, stateAt(MAIN, T0 + 150_000, { speedMps: 20, alongM: 1500 }), T0 + 150_000)
    expect(driveJams(meter, T0 + 151_000, true).list).toEqual([{ atSec: 60, durationSec: 90, drivenM: 1500 }])
  })

  it('after a gap of more than 15 s, a crawl the car drove out of at speed is unknown, never a jam of the whole gap', () => {
    const gap = (gapSec: number, movedM: number, r: RouteCandidate = MAIN) => {
      let meter = drive([[60, 25]]).meter
      meter = meterJamFix(meter, stateAt(MAIN, T0 + 60_000, { speedMps: 5, alongM: 1500 }), T0 + 60_000)
      const then = T0 + 60_000 + gapSec * 1000
      meter = meterJamFix(meter, stateAt(r, then, { speedMps: 25, alongM: 1500 + movedM }), then)
      return driveJams(meter, then + 1000, true)
    }
    // No fix for 8 minutes (the phone lost its position), and the car is 12 km further on: nobody saw a jam.
    expect(gap(480, 12_000)).toEqual({ list: [], count: 0, jamSec: 0, unknownSec: 480 })
    // The same gap with 1 km of progress (about 2 m/s): it crawled.
    expect(gap(480, 1000).list).toEqual([{ atSec: 60, durationSec: 480, drivenM: 1500 }])
    // Progress at exactly 6.7 m/s is not a crawl; a gap of exactly 15 s is not a gap.
    expect(gap(100, 670).unknownSec).toBe(100)
    expect(gap(100, 669).jamSec).toBe(100)
    expect(gap(15, 375).unknownSec).toBe(0)
    expect(gap(16, 400).unknownSec).toBe(0) // 16 s: under 30 s, so nothing either way
    expect(gap(40, 1000)).toEqual({ list: [], count: 0, jamSec: 0, unknownSec: 40 })
    // On another route after the gap, progress cannot be told: unknown.
    expect(gap(480, 0, route('route-other')).unknownSec).toBe(480)
  })

  it('a device speed that is not a speed (negative, as iOS sends for "invalid") is not a crawl: the smoothed speed is used', () => {
    let meter = drive([[10, 25]]).meter
    for (let s = 10; s < 70; s++) meter = meterJamFix(meter, stateAt(MAIN, T0 + s * 1000, { speedMps: -1, smoothedMps: 25, alongM: s * 25 }), T0 + s * 1000)
    expect(driveJams(meter, T0 + 70_000, true).count).toBe(0)
  })

  it('uses the smoothed speed when the device gives none', () => {
    let meter = drive([[10, 25]]).meter
    for (let s = 10; s < 50; s++) meter = meterJamFix(meter, stateAt(MAIN, T0 + s * 1000, { speedMps: null, smoothedMps: 3, alongM: 250 + (s - 10) * 3 }), T0 + s * 1000)
    meter = meterJamFix(meter, stateAt(MAIN, T0 + 50_000, { speedMps: null, smoothedMps: 20, alongM: 400 }), T0 + 50_000)
    expect(driveJams(meter, T0 + 51_000, true).jamSec).toBe(40)
  })

  it('lists at most 50 jams; the totals count every one', () => {
    const legs: Leg[] = [[10, 25]]
    for (let i = 0; i < 52; i++) legs.push([30, 4], [2, 25])
    const jams = jamsOf(legs)
    expect(jams.list).toHaveLength(50)
    expect([jams.count, jams.jamSec]).toEqual([52, 52 * 30])
  })
})

describe('what is not counted', () => {
  it('crawling on a side street is not a jam, and turning onto one ends the jam there', () => {
    // 10 km of main road at 25 m/s takes 400 s; the side street is 5 km.
    expect(jamsOf([[400, 25], [180, 4], [100, 25]])).toEqual({ list: [], count: 0, jamSec: 0, unknownSec: 0 })
    expect(jamWords(jamsOf([[400, 25], [180, 4], [100, 25]]))).toBe('none')
    // 40 s of crawling up to the turn (9840 m on), then crawling on the side street.
    const jams = jamsOf([[392, 25], [40, 5], [120, 5]], { fromM: 0 })
    expect(jams.list).toEqual([{ atSec: 392, durationSec: 40, drivenM: 9800 }])
    // 20 s on the main road and then the side street: under 30 s, so none.
    expect(jamsOf([[396, 25], [20, 5], [120, 5]]).count).toBe(0)
  })

  it('the wait before the car first sets off (1.5 m/s) is not counted; a drive begun inside a crawl is', () => {
    expect(jamsOf([[120, 0], [10, 1.4], [60, 25]]).count).toBe(0)
    const jams = jamsOf([[120, 0], [60, 3], [60, 25]])
    expect(jams.list).toEqual([{ atSec: 120, durationSec: 60, drivenM: 0 }])
  })

  it('a tick (the same fix again) and a state that is not a drive under way change nothing', () => {
    const { meter } = drive([[60, 25], [10, 4]])
    const last = stateAt(MAIN, T0 + 69_000, { speedMps: 4, alongM: 1536 })
    const seen = meterJamFix(meter, last, T0 + 69_000)
    expect(meterJamFix(seen, last, T0 + 99_000)).toBe(seen)
    const fresh = stateAt(MAIN, T0 + 99_000, { speedMps: 4, alongM: 1600 })
    expect(meterJamFix(seen, { ...fresh, status: 'arrived' }, T0 + 99_000)).toBe(seen)
    expect(meterJamFix(seen, { ...fresh, tracking: null }, T0 + 99_000)).toBe(seen)
  })

  it('a crawl still under way is closed when the drive is over; in a record written mid-drive it is unknown time, never "none"', () => {
    const { meter, ms } = drive([[60, 25], [45, 4]])
    const mid = driveJams(meter, ms, false)
    expect(mid).toEqual({ list: [], count: 0, jamSec: 0, unknownSec: 45 })
    expect(jamWords(mid)).toBe('unknown')
    expect(driveJams(meter, ms, true).list).toEqual([{ atSec: 60, durationSec: 45, drivenM: 1500 }])
    // No crawl under way: a mid-drive record is as known as a final one.
    const free = drive([[60, 25], [45, 4], [5, 25]])
    expect(driveJams(free.meter, free.ms, false)).toEqual(driveJams(free.meter, free.ms, true))
  })

  it('End long after the last fix (the drive had lost its position) ends the crawl at that fix, not at the tap', () => {
    const { meter, ms } = drive([[60, 25], [40, 4]])
    // The last fix was at ms - 1000. End 10 minutes later.
    expect(driveJams(meter, ms + 600_000, true).list).toEqual([{ atSec: 60, durationSec: 39, drivenM: 1500 }])
    // Up to 15 s after the last fix the tap is the end.
    expect(driveJams(meter, ms + 14_000, true).list[0]!.durationSec).toBe(54)
  })
})

describe('unknown is never zero', () => {
  it('slow driving where the provider did not say what kind of road it is: unknown time, not a jam and not "none"', () => {
    for (const spans of [null, undefined, []] as const) {
      const jams = jamsOf([[60, 25], [180, 4], [60, 25]], { r: route('route-plain', spans) })
      expect(jams).toEqual({ list: [], count: 0, jamSec: 0, unknownSec: 180 })
      expect(jamWords(jams)).toBe('unknown')
      expect(knownJamSec(jams)).toBeNull()
    }
  })

  it('a slow run under 30 s on a road of unknown kind could not have been a jam: the drive stays known', () => {
    const jams = jamsOf([[60, 25], [29, 4], [60, 25]], { r: route('route-plain', null) })
    expect(jams.unknownSec).toBe(0)
    expect(knownJamSec(jams)).toBe(0)
  })

  it('off the route the kind of road is unknown, and a crawl that is partly unknown is unknown as a whole', () => {
    // A jam of 60 s that is known, then a crawl of 100 s whose middle is off the route.
    const jams = jamsOf([[60, 25], [60, 4], [20, 25], [100, 4], [60, 25]], { offRoute: (sec) => sec >= 180 && sec < 200 })
    expect(jams).toEqual({ list: [{ atSec: 60, durationSec: 60, drivenM: 1500 }], count: 1, jamSec: 60, unknownSec: 100 })
    // A lower bound, and said so.
    expect(jamWords(jams)).toBe('≥ 1 min in 1 jam (partial)')
    expect(knownJamSec(jams)).toBeNull()
  })

  it('a stretch no span covers is of unknown kind; where one span ends and the next begins is the next', () => {
    const gap: RoadKindSpan[] = [
      { startM: 0, endM: 1000, kind: 'main' },
      { startM: 2000, endM: 3000, kind: 'side' },
    ]
    expect([0, 999, 1000, 1500, 2000, 3000, 3001].map((m) => roadKindAt(gap, m))).toEqual(['main', 'main', 'main', null, 'side', 'side', null])
    expect([9999, 10_000, 15_000].map((m) => roadKindAt(SPANS, m))).toEqual(['main', 'side', 'main'])
    expect(roadKindAt(null, 0)).toBeNull()
    expect(roadKindAt(undefined, 0)).toBeNull()
  })
})

describe('kept with the drive', () => {
  const context = () => ({ otherAppSec: null, hourOf: () => 8 })
  /** Runs the drive log's recorder with the jam meter beside it, as the app does. */
  function record(legs: readonly Leg[], end: 'arrived' | 'ended', r: RouteCandidate = MAIN) {
    let rec: JamRecorder = JAM_RECORDER_IDLE
    let alongM = 0
    let ms = T0
    const writes: DriveRecord[] = []
    const feed = (state: LiveState) => {
      const step = observeJams(rec, state, ms, (d) => observeDrive(d, state, ms, context))
      rec = step.recorder
      if (step.write !== null) writes.push(step.write)
      return step
    }
    for (const [forSec, mps] of legs) {
      for (let i = 0; i < forSec; i++) {
        feed(stateAt(r, ms, { speedMps: mps, alongM }))
        alongM += mps
        ms += 1000
      }
    }
    const last = stateAt(r, ms, { speedMps: 0, alongM })
    if (end === 'arrived') feed({ ...last, status: 'arrived' })
    else {
      const step = endJams(rec, ms, (d) => endDrive(d, last, ms))
      rec = step.recorder
      if (step.write !== null) writes.push(step.write)
    }
    return { writes, rec, feed, ms }
  }

  it('the arrived record carries the jams, and nothing is written on the way', () => {
    const { writes, rec } = record([[60, 25], [90, 4], [30, 25]], 'arrived')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ outcome: 'arrived', actualSec: 180, jams: { list: [{ atSec: 60, durationSec: 90, drivenM: 1500 }], count: 1, jamSec: 90, unknownSec: 0 } })
    expect(rec.meter).toBeNull()
  })

  it('arriving inside a crawl keeps the crawl up to the arrival', () => {
    const { writes } = record([[60, 25], [50, 4]], 'arrived')
    expect(writes[0]).toMatchObject({ outcome: 'arrived', jams: { list: [{ atSec: 60, durationSec: 50, drivenM: 1500 }], count: 1, jamSec: 50, unknownSec: 0 } })
  })

  it('End inside a crawl keeps the crawl up to the tap', () => {
    const { writes } = record([[60, 25], [50, 4]], 'ended')
    expect(writes[0]).toMatchObject({ outcome: 'ended', jams: { count: 1, jamSec: 50 } })
  })

  it('on a tick the very same recorder comes back, with nothing to write', () => {
    let rec: JamRecorder = JAM_RECORDER_IDLE
    const state = stateAt(MAIN, T0, { speedMps: 25, alongM: 0 })
    rec = observeJams(rec, state, T0, (d) => observeDrive(d, state, T0, context)).recorder
    expect(rec.meter).not.toBeNull()
    const tick = observeJams(rec, state, T0 + 1000, (d) => observeDrive(d, state, T0 + 1000, context))
    expect(tick.recorder).toBe(rec)
    expect(tick.write).toBeNull()
  })

  it('nothing in the stored jams looks like a position, and they read back as written', () => {
    const { writes } = record([[60, 25], [90, 4], [30, 25]], 'arrived')
    const text = JSON.stringify(recordDrive(EMPTY_DRIVE_LOG, writes[0]!))
    expect(text).not.toMatch(/-?\d{1,3}\.\d{4,}/)
    expect(parseDriveLog(JSON.parse(text))!.drives[0]!.jams).toEqual(writes[0]!.jams)
  })

  it('a record from before jams were measured reads back as not measured, never as no jams', () => {
    const { writes } = record([[60, 25]], 'arrived')
    const { jams: _jams, ...old } = writes[0]!
    const read = parseDriveLog({ version: 1, drives: [old] })!.drives[0]!
    expect(read.jams).toBeNull()
    expect(jamWords(read.jams)).toBe('not measured')
    expect(knownJamSec(read.jams)).toBeNull()
  })

  it('stored jams that are not jams read as not measured, and anything extra in them is not carried along', () => {
    const good = { list: [{ atSec: 60, durationSec: 90, drivenM: 1500 }], count: 1, jamSec: 90, unknownSec: 0 }
    expect(parseDriveJams({ ...good, list: [{ ...good.list[0], lng: -80.8431, lat: 35.2271 }], where: 'Uptown' })).toEqual(good)
    for (const bad of [undefined, null, 7, [], { ...good, list: 'none' }, { ...good, jamSec: -1 }, { ...good, count: 0 }, { ...good, unknownSec: null }, { ...good, list: [{ atSec: 60 }] }]) {
      expect(parseDriveJams(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('the CSV has jam_min last: minutes when known in full, blank when unknown or not measured', () => {
    expect(DRIVE_LOG_CSV_HEADER.endsWith(',requests,jam_min')).toBe(true)
    const known = record([[60, 25], [90, 4], [30, 25]], 'arrived').writes[0]!
    const unknown = { ...record([[60, 25], [90, 4], [30, 25]], 'arrived', route('route-plain', null)).writes[0]!, id: 'd2', startedAtMs: T0 + 1 }
    const old = { ...known, id: 'd3', startedAtMs: T0 + 2, jams: null }
    const none = { ...record([[60, 25]], 'arrived').writes[0]!, id: 'd4', startedAtMs: T0 + 3 }
    const rows = driveLogCsv([known, unknown, old, none].reduce((l, d) => recordDrive(l, d), EMPTY_DRIVE_LOG)).split('\n').slice(1)
    expect(rows.map((r) => r.split(',').at(-1))).toEqual(['1.5', '', '', '0.0'])
  })
})

describe('the drive diagnostics line', () => {
  it('says the totals in whole numbers with a cap: nothing that looks like a position can get into it', () => {
    const log = createDriveDiagnostics(() => T0)
    expect(log.text()).not.toContain('in jams')
    log.jams({ jamSec: 360, count: 2, unknownSec: 0 })
    expect(log.text().split('\n')).toContain('in jams on main roads (latest drive): 6 min in 2 jams')
    log.jams(null)
    expect(log.text().split('\n')).toContain('in jams on main roads (latest drive): not measured')
    // Numbers that are not totals at all: rounded to whole ones and capped.
    const line = () => log.text().split('\n').find((l) => l.startsWith('in jams'))!
    log.jams({ jamSec: 35.2271, count: 80.8431, unknownSec: 0 })
    expect(line()).toBe('in jams on main roads (latest drive): 35 s in 81 jams')
    log.jams({ jamSec: 30, count: 80_843_100, unknownSec: 0 })
    expect(line()).toBe(`in jams on main roads (latest drive): 30 s in ${JAM_TOTAL_CAP} jams`)
  })
})

describe('per corridor', () => {
  const drive = (jamSec: number | null, extra: { corridor?: string; outcome?: string; unknownSec?: number } = {}) => ({
    corridor: extra.corridor ?? 'c1',
    outcome: extra.outcome ?? 'arrived',
    jams: jamSec === null ? null : { list: [], count: jamSec > 0 ? 1 : 0, jamSec, unknownSec: extra.unknownSec ?? 0 },
  })

  it('averages the arrived drives whose jam time is known; a drive with none counts as 0', () => {
    const c = corridorJams([drive(360), drive(0), drive(180), drive(999, { corridor: 'c2' })], 'c1')
    expect(c).toEqual({ drives: 3, meanJamSec: 180, leftOut: 0 })
    expect(corridorJamWords(c)).toBe('3.0 min per drive on average (3 drives)')
  })

  it('leaves out drives that were not measured, partly unknown or ended early: never averaged as 0', () => {
    const c = corridorJams([drive(300), drive(null), drive(60, { unknownSec: 90 }), drive(0, { outcome: 'ended' }), drive(0, { outcome: 'unfinished' })], 'c1')
    expect(c).toEqual({ drives: 1, meanJamSec: 300, leftOut: 2 })
    expect(corridorJamWords(c)).toBe('5.0 min per drive on average (1 drive; 2 with unknown jam time left out)')
    const none = corridorJams([drive(null)], 'c1')
    expect(none).toEqual({ drives: 0, meanJamSec: null, leftOut: 1 })
    expect(corridorJamWords(none)).toBe('no measured drives yet (1 with unknown jam time left out)')
    expect(corridorJamWords(corridorJams([], 'c1'))).toBe('no measured drives yet')
  })
})
