import { describe, expect, it } from 'vitest'
import {
  corridorKey,
  corridorLabels,
  DEFAULT_DRIVE_LOG_OPTIONS,
  DRIVE_LOG_CSV_HEADER,
  DRIVE_LOG_VERSION,
  driveLogCsv,
  EMPTY_DRIVE_LOG,
  endDrive,
  errorWords,
  hourLabel,
  LIVE_IDLE,
  median,
  observeDrive,
  parseDriveLog,
  parseOtherAppEta,
  RECORDER_IDLE,
  recordDrive,
  summarizeDriveLog,
  type DriveContext,
  type DriveLog,
  type DriveRecord,
  type DriveRecorder,
  type LiveState,
  type LiveSwitch,
  type LngLat,
  type RouteCandidate,
} from '../src/core/index.ts'
import { memoryTextStore } from '../src/storage/local.ts'
import { clearDriveLog, DRIVE_LOG_KEY, loadDriveLog, saveDriveLog } from '../src/storage/driveLog.ts'

// The private drive log (#107): the spec for the Swift port of core/driveLog.ts.

const UPTOWN: LngLat = [-80.8431, 35.2271]
const INDIAN_LAND: LngLat = [-80.8561, 35.0015]
const T0 = 1_800_000_000_000

/** Anything that looks like a coordinate: a number with four or more decimals. */
const COORDINATE = /-?\d{1,3}\.\d{4,}/

function route(id: string, durationSec: number, extra: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    id,
    geometry: [UPTOWN, INDIAN_LAND],
    durationSec,
    typicalDurationSec: null,
    distanceM: 25_000,
    signalCount: 14,
    signalCoverage: 'full',
    providerSignalCount: null,
    intersections: null,
    limitedAccessSpansM: [],
    maneuvers: [],
    ...extra,
  } as RouteCandidate
}

const fixAt = ([lng, lat]: LngLat, timeMs: number) => ({ lng, lat, accuracyM: 5, speedMps: 20, headingDeg: 180, timeMs })

const context = (otherAppSec: number | null = null) => (): DriveContext => ({ otherAppSec, hourOf: () => 8 })

/** A drive that has just begun on `r`, from Uptown. */
function driving(r: RouteCandidate, extra: Partial<LiveState> = {}): LiveState {
  return {
    ...LIVE_IDLE,
    status: 'driving',
    destination: INDIAN_LAND,
    startedAtMs: T0 - 3000,
    route: r,
    lastFix: fixAt(UPTOWN, T0),
    eta: { durationSec: r.durationSec, remainingM: r.distanceM },
    requestsUsed: 1,
    ...extra,
  }
}

const sw = (atMs: number, savingSec: number | null, code: LiveSwitch['code'] = 'faster-route'): LiveSwitch => ({ atMs, code, reason: 'Switching', savingSec })

describe('corridorKey', () => {
  it('is the same for the same trip, and another for the way back', () => {
    const there = corridorKey(UPTOWN, INDIAN_LAND)
    expect(there).toMatch(/^c[0-9a-f]{12}$/)
    expect(corridorKey(UPTOWN, INDIAN_LAND)).toBe(there)
    expect(corridorKey(INDIAN_LAND, UPTOWN)).not.toBe(there)
  })

  it('rounds each end to a grid of 0.01° (about a kilometre): a start 300 m away is the same corridor', () => {
    expect(DEFAULT_DRIVE_LOG_OPTIONS.corridorGridDeg).toBe(0.01)
    const near: LngLat = [UPTOWN[0] + 0.002, UPTOWN[1] - 0.002]
    expect(corridorKey(near, INDIAN_LAND)).toBe(corridorKey(UPTOWN, INDIAN_LAND))
    const far: LngLat = [UPTOWN[0] + 0.02, UPTOWN[1]]
    expect(corridorKey(far, INDIAN_LAND)).not.toBe(corridorKey(UPTOWN, INDIAN_LAND))
  })
})

describe('parseOtherAppEta', () => {
  it('reads minutes, "19 min" and hours:minutes', () => {
    expect(parseOtherAppEta('19')).toEqual({ sec: 1140, problem: null })
    expect(parseOtherAppEta(' 19 min ')).toEqual({ sec: 1140, problem: null })
    expect(parseOtherAppEta('1:05')).toEqual({ sec: 3900, problem: null })
  })

  it('empty is none; anything else is a problem, never a guess', () => {
    expect(parseOtherAppEta('')).toEqual({ sec: null, problem: null })
    for (const bad of ['0', 'abc', '8:15 am', '1:75', '601', '-5', '19.5']) {
      expect(parseOtherAppEta(bad).sec, bad).toBeNull()
      expect(parseOtherAppEta(bad).problem, bad).not.toBeNull()
    }
  })
})

describe('the recorder', () => {
  it('begins a record when the drive begins on its first route, and writes nothing yet', () => {
    const locating = observeDrive(RECORDER_IDLE, { ...LIVE_IDLE, status: 'locating' }, T0 - 2000, context())
    expect(locating).toEqual({ recorder: RECORDER_IDLE, write: null })

    const r = route('route-aaaa', 1170, { signalCount: 3, signalCoverage: 'partial' })
    const step = observeDrive(RECORDER_IDLE, driving(r), T0, context(1140))
    expect(step.write).toBeNull()
    expect(step.recorder.draft).toMatchObject({
      id: `d${T0}`,
      startedAtMs: T0,
      startHour: 8,
      corridor: corridorKey(UPTOWN, INDIAN_LAND),
      routeSource: 'provider',
      predictedSec: 1170,
      distanceM: 25_000,
      signals: { count: 3, partial: true },
      otherAppSec: 1140,
      outcome: 'unfinished',
    })
  })

  it('keeps unknown lights unknown, never 0', () => {
    const r = route('route-aaaa', 1170, { signalCount: null, signalCoverage: 'none' })
    expect(observeDrive(RECORDER_IDLE, driving(r), T0, context()).recorder.draft!.signals).toBeNull()
  })

  it('on a tick answers the very same recorder: no work, no write', () => {
    const state = driving(route('route-aaaa', 1170))
    const started = observeDrive(RECORDER_IDLE, state, T0, context()).recorder
    let asked = 0
    const counting = () => {
      asked++
      return context()()
    }
    const tick = observeDrive(started, { ...state, lastFix: fixAt(UPTOWN, T0 + 1000) }, T0 + 1000, counting)
    expect(tick.recorder).toBe(started)
    expect(tick.write).toBeNull()
    expect(asked).toBe(0)
  })

  it('writes at a switch, with the claimed saving and the new route', () => {
    const a = route('route-aaaa', 1170)
    let rec: DriveRecorder = observeDrive(RECORDER_IDLE, driving(a), T0, context()).recorder
    const b = route('route-bbbb', 600, { source: 'probe' })
    const step = observeDrive(rec, driving(b, { switches: [sw(T0 + 300_000, 120)], requestsUsed: 7 }), T0 + 300_000, context())
    expect(step.write).not.toBeNull()
    expect(step.write!.switches).toEqual([
      { atSec: 300, code: 'faster-route', accepted: true, claimedSavingSec: 120, newRouteSec: 600, realisedSavingSec: null, toSource: 'probe' },
    ])
    expect(step.write).toMatchObject({ outcome: 'unfinished', requests: 7, actualSec: 300 })
    rec = step.recorder
    expect(rec.draft).toEqual(step.write)
  })

  it('marks a switch turned down with "Keep previous route", and writes', () => {
    const a = route('route-aaaa', 1170)
    let rec = observeDrive(RECORDER_IDLE, driving(a), T0, context()).recorder
    rec = observeDrive(rec, driving(route('route-bbbb', 600), { switches: [sw(T0 + 300_000, 120)] }), T0 + 300_000, context()).recorder
    const kept = observeDrive(rec, driving(a, { switches: [], declinedSwitches: 1 }), T0 + 303_000, context())
    expect(kept.write!.switches).toMatchObject([{ accepted: false, claimedSavingSec: 120 }])
  })

  it('counts each "off the route" excursion once, without a write', () => {
    const a = route('route-aaaa', 1170)
    let rec = observeDrive(RECORDER_IDLE, driving(a), T0, context()).recorder
    for (const [i, off] of [true, true, false, true].entries()) {
      const step = observeDrive(rec, driving(a, { offRouteNotified: off }), T0 + i * 1000, context())
      expect(step.write).toBeNull()
      rec = step.recorder
    }
    expect(rec.draft!.offRouteEvents).toBe(2)
  })

  it('on arrival writes the real time and the saving each kept switch really made', () => {
    const a = route('route-aaaa', 1200)
    let rec = observeDrive(RECORDER_IDLE, driving(a), T0, context(1140)).recorder
    // At minute 5 it switches to a route of 10 minutes, claiming 2 minutes: the old route was 12 minutes from there.
    rec = observeDrive(rec, driving(route('route-bbbb', 600), { switches: [sw(T0 + 300_000, 120)] }), T0 + 300_000, context()).recorder
    // The rest takes 11 minutes: 1 minute saved, not 2.
    const arrived = { ...driving(route('route-bbbb', 600)), status: 'arrived' as const, switches: [sw(T0 + 300_000, 120)], requestsUsed: 17 }
    const step = observeDrive(rec, arrived, T0 + 960_000, context())
    expect(step.write).toMatchObject({ outcome: 'arrived', endedAtMs: T0 + 960_000, actualSec: 960, requests: 17, otherAppSec: 1140 })
    expect(step.write!.switches[0]!.realisedSavingSec).toBe(60)
    // Done: the Done tap (End) that follows writes nothing more.
    expect(step.recorder.done).toBe(true)
    expect(endDrive(step.recorder, arrived, T0 + 970_000).write).toBeNull()
    expect(observeDrive(step.recorder, arrived, T0 + 980_000, context()).write).toBeNull()
  })

  it('gives a realised saving to the last kept switch only: an earlier one would be credited with the later gains', () => {
    const a = route('route-aaaa', 1200)
    let rec = observeDrive(RECORDER_IDLE, driving(a), T0, context()).recorder
    const one = sw(T0 + 300_000, 60)
    const two = sw(T0 + 600_000, 60)
    rec = observeDrive(rec, driving(route('route-bbbb', 840), { switches: [one] }), T0 + 300_000, context()).recorder
    rec = observeDrive(rec, driving(route('route-cccc', 480), { switches: [one, two] }), T0 + 600_000, context()).recorder
    const arrived = { ...driving(route('route-cccc', 480)), status: 'arrived' as const, switches: [one, two] }
    const step = observeDrive(rec, arrived, T0 + 1_080_000, context())
    // The second: 8 + 1 minutes predicted on the route it left, 8 minutes taken.
    expect(step.write!.switches.map((s) => s.realisedSavingSec)).toEqual([null, 60])
  })

  it('takes the corridor from the drive\'s own destination, not from anything passed in', () => {
    const elsewhere: LngLat = [-80.7, 35.1]
    const draft = observeDrive(RECORDER_IDLE, driving(route('route-aaaa', 1170), { destination: elsewhere }), T0, context()).recorder.draft!
    expect(draft.corridor).toBe(corridorKey(UPTOWN, elsewhere))
  })

  it('leaves the realised saving unknown for a closure, an off-route route and a drive ended early', () => {
    const a = route('route-aaaa', 1200)
    let rec = observeDrive(RECORDER_IDLE, driving(a), T0, context()).recorder
    rec = observeDrive(rec, driving(route('route-cccc', 900), { switches: [sw(T0 + 60_000, null, 'off-route')] }), T0 + 60_000, context()).recorder
    rec = observeDrive(rec, driving(route('route-dddd', 800), { switches: [sw(T0 + 60_000, null, 'off-route'), sw(T0 + 120_000, 90)] }), T0 + 120_000, context()).recorder
    const ended = endDrive(rec, driving(route('route-dddd', 800)), T0 + 200_000)
    expect(ended.write).toMatchObject({ outcome: 'ended', actualSec: 200, endedAtMs: T0 + 200_000 })
    expect(ended.write!.switches.map((s) => s.realisedSavingSec)).toEqual([null, null])
  })

  it('End before the drive began on a route writes nothing', () => {
    expect(endDrive(RECORDER_IDLE, { ...LIVE_IDLE, status: 'locating' }, T0).write).toBeNull()
  })
})

function record(id: number, extra: Partial<DriveRecord> = {}): DriveRecord {
  return {
    id: `d${id}`,
    startedAtMs: id,
    startHour: 8,
    endedAtMs: id + 1_000_000,
    corridor: 'c0123456789ab',
    routeSource: 'provider',
    predictedSec: 1200,
    actualSec: 1260,
    distanceM: 25_000,
    signals: { count: 14, partial: false },
    otherAppSec: null,
    switches: [],
    offRouteEvents: 0,
    requests: 17,
    outcome: 'arrived',
    ...extra,
  }
}

describe('the log', () => {
  it('replaces a record with the same id, keeps start order, and drops the oldest beyond maxDrives', () => {
    expect(DEFAULT_DRIVE_LOG_OPTIONS.maxDrives).toBe(500)
    let log: DriveLog = EMPTY_DRIVE_LOG
    log = recordDrive(log, record(2, { outcome: 'unfinished' }))
    log = recordDrive(log, record(1))
    log = recordDrive(log, record(2))
    expect(log.drives.map((d) => [d.id, d.outcome])).toEqual([
      ['d1', 'arrived'],
      ['d2', 'arrived'],
    ])
    log = recordDrive(log, record(3), { maxDrives: 2 })
    expect(log.drives.map((d) => d.id)).toEqual(['d2', 'd3'])
  })

  it('reads back only a log of this version, and drops a damaged record by itself', () => {
    expect(DRIVE_LOG_VERSION).toBe(1)
    expect(parseDriveLog(null)).toBeNull()
    expect(parseDriveLog({ version: 2, drives: [] })).toBeNull()
    const raw = { version: 1, drives: [record(1), { ...record(2), corridor: 'Uptown Charlotte' }, { ...record(3), predictedSec: 'soon' }] }
    expect(parseDriveLog(JSON.parse(JSON.stringify(raw)))!.drives.map((d) => d.id)).toEqual(['d1'])
  })

  it('carries no field it does not know (a position slipped into a record is not read back)', () => {
    const raw = { version: 1, drives: [{ ...record(1), origin: UPTOWN, destinationLabel: 'Uptown' }] }
    const log = parseDriveLog(raw)!
    expect(JSON.stringify(log)).not.toMatch(COORDINATE)
    expect(JSON.stringify(log)).not.toContain('Uptown')
  })

  it('stores no coordinates and no addresses: a whole recorded drive, as written, matches no coordinate pattern', () => {
    const a = route('route-aaaa', 1170)
    let rec = observeDrive(RECORDER_IDLE, driving(a), T0, context(1140)).recorder
    rec = observeDrive(rec, driving(route('route-bbbb', 600), { switches: [sw(T0 + 300_000, 120)] }), T0 + 300_000, context()).recorder
    const done = observeDrive(rec, { ...driving(route('route-bbbb', 600)), status: 'arrived', switches: [sw(T0 + 300_000, 120)] }, T0 + 1_000_000, context())
    const store = memoryTextStore()
    saveDriveLog(store, recordDrive(EMPTY_DRIVE_LOG, done.write!))
    const text = store.read(DRIVE_LOG_KEY)!
    expect(text).not.toMatch(COORDINATE)
    expect(text).not.toContain(String(UPTOWN[0]).slice(0, 6))
    expect(text).not.toContain('geometry')
    // Not even the route's id: it is a hash of the exact geometry.
    expect(text).not.toContain('route-')
    expect(driveLogCsv(loadDriveLog(store))).not.toMatch(COORDINATE)
  })
})

describe('storage', () => {
  it('reads back what it wrote, removes text that is not a log, and clears', () => {
    const store = memoryTextStore()
    expect(loadDriveLog(store)).toEqual(EMPTY_DRIVE_LOG)
    const log = recordDrive(EMPTY_DRIVE_LOG, record(1))
    expect(saveDriveLog(store, log)).toBe(true)
    expect(loadDriveLog(store)).toEqual(log)
    store.write(DRIVE_LOG_KEY, '{not json')
    expect(loadDriveLog(store)).toEqual(EMPTY_DRIVE_LOG)
    expect(store.read(DRIVE_LOG_KEY)).toBeNull()
    saveDriveLog(store, log)
    expect(clearDriveLog(store)).toBe(true)
    expect(store.read(DRIVE_LOG_KEY)).toBeNull()
  })
})

describe('summaries', () => {
  it('median', () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
  })

  it('compares arrived drives only, by corridor, hour of day and route source', () => {
    const other = 'cfedcba987654'
    const log = [
      record(1, { startHour: 8, actualSec: 1260 }),
      record(2, { startHour: 8, actualSec: 1380 }),
      record(3, { startHour: 17, actualSec: 1500, routeSource: 'probe', otherAppSec: 1320 }),
      record(4, { outcome: 'ended', actualSec: 100 }),
      record(5, { corridor: other, outcome: 'unfinished' }),
    ].reduce((l, r) => recordDrive(l, r), EMPTY_DRIVE_LOG)
    const [a, b] = summarizeDriveLog(log)
    expect(corridorLabels(log).get(other)).toBe('B')
    expect(a).toMatchObject({ label: 'A', drives: 4, arrived: 3, medianErrorSec: 180 })
    expect(a!.byHour).toEqual([
      { key: 8, drives: 2, medianErrorSec: 120 },
      { key: 17, drives: 1, medianErrorSec: 300 },
    ])
    expect(a!.bySource).toEqual([
      { key: 'probe', drives: 1, medianErrorSec: 300 },
      { key: 'provider', drives: 2, medianErrorSec: 120 },
    ])
    expect(a!.otherApp).toEqual({ key: 'other-app', drives: 1, medianErrorSec: 180 })
    expect(b).toMatchObject({ label: 'B', drives: 1, arrived: 0, medianErrorSec: null, byHour: [], bySource: [], otherApp: null })
  })

  it('words and hours', () => {
    expect(errorWords(20)).toBe('on time')
    expect(errorWords(130)).toBe('2 min longer than predicted')
    expect(errorWords(-61)).toBe('1 min shorter than predicted')
    expect([0, 8, 12, 17].map(hourLabel)).toEqual(['12 am', '8 am', '12 pm', '5 pm'])
  })

  it('CSV: one row per drive, unknown left blank, partial lights as a lower bound', () => {
    const log = [
      record(1_800_000_000_000, { otherAppSec: 1200, signals: { count: 3, partial: true } }),
      record(1_800_000_100_000, { outcome: 'ended', signals: null, switches: [{ atSec: 60, code: 'faster-route', accepted: false, claimedSavingSec: 90, newRouteSec: 600, realisedSavingSec: null, toSource: 'provider' }] }),
    ].reduce((l, r) => recordDrive(l, r), EMPTY_DRIVE_LOG)
    expect(driveLogCsv(log).split('\n')).toEqual([
      DRIVE_LOG_CSV_HEADER,
      '2027-01-15T08:00:00.000Z,A,8,arrived,provider,20.0,21.0,1.0,20.0,1.0,25.0,≥3,0,0,,,0,17',
      '2027-01-15T08:01:40.000Z,A,8,ended,provider,20.0,21.0,,,,25.0,,0,1,,,0,17',
    ])
  })
})
