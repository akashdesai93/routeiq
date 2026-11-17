import type { LiveState } from './live.ts'
import type { PositionFix } from './tracking.ts'
import type { RoadKind, RoadKindSpan, RouteCandidate } from './types.ts'

/**
 * How long the car crawled in jams on main roads during a drive (#227): the
 * most a side-street bypass could ever have won (docs/jam-bypass.md). Measured
 * during a live drive and kept in the private drive log (driveLog.ts), on the
 * device only. It measures; no rule of the reroute engine reads it.
 *
 * A jam is a run of fixes under jamSpeedMps that lasts minJamSec or more, on
 * a road that is not a side street. Stops inside the run are part of it. The
 * kind of road comes from the route being driven (RouteCandidate.roadKindSpansM);
 * where it is not known, slow driving counts as unknown: never as a jam and
 * never as "no jam".
 *
 * Nothing here keeps a position. A jam is kept as seconds into the drive, how
 * long it lasted and the meters driven before it, rounded.
 *
 * Cost per GPS fix: a few comparisons and one small object. No search, no
 * storage write.
 *
 * Pure: time comes in as an argument.
 */

/** Every threshold of the jam meter. See DEFAULT_JAM_OPTIONS for the values. */
export interface JamOptions {
  /**
   * Below this speed the car is crawling, in meters per second. The device's
   * own speed reading when it gives one, else the drive's smoothed speed
   * (tracking.ts).
   */
  readonly jamSpeedMps: number
  /** A slow run shorter than this is not a jam (slowing for a turn, a short wait), in seconds. */
  readonly minJamSec: number
  /**
   * Nothing is measured until the car has first reached this speed, in meters
   * per second: a drive started while parked does not count the wait before it sets off.
   */
  readonly setOffSpeedMps: number
  /**
   * Two fixes farther apart than this, in seconds, are a gap: the car was not
   * watched in between. A crawl goes on across a gap only when the progress
   * along the route shows the car kept under jamSpeedMps (it stood still and
   * the phone held its fixes back); otherwise the crawl is marked unknown. At
   * the End tap, a crawl whose last fix is older than this ends at that fix.
   */
  readonly maxFixGapSec: number
  /** At most this many jams are listed per drive. The totals count every jam. */
  readonly maxJamsKept: number
  /** Meters driven before a jam are stored rounded to this many meters: enough for "3.6 mi in", not a place. */
  readonly drivenRoundM: number
}

export const DEFAULT_JAM_OPTIONS: JamOptions = {
  jamSpeedMps: 6.7,
  minJamSec: 30,
  setOffSpeedMps: 1.5,
  maxFixGapSec: 15,
  maxJamsKept: 50,
  drivenRoundM: 100,
}

/** One jam, as kept in the drive log. No position. */
export interface LoggedJam {
  /** Seconds after the drive began, when the crawl began. */
  readonly atSec: number
  readonly durationSec: number
  /** Meters driven along the drive's routes before the jam, rounded to drivenRoundM. */
  readonly drivenM: number
}

/** A drive's jams, as kept in its record. */
export interface DriveJams {
  /** The jams kept, in order; at most maxJamsKept (the totals still count all). */
  readonly list: readonly LoggedJam[]
  /** Jams on main roads, all of them. */
  readonly count: number
  /** Time in those jams, in seconds. */
  readonly jamSec: number
  /**
   * Time in slow runs of minJamSec or more where the kind of road was not
   * known for some part (the provider did not say, or the car was off the
   * route), in seconds. Above 0, jamSec and count are lower bounds: the
   * jam time of the drive is not known in full, and is never shown or
   * averaged as a plain number.
   */
  readonly unknownSec: number
}

/** The meter's state during a drive. In memory only: it holds the route being driven. */
export interface JamMeter {
  /** When the drive began (the drive's clock): jams are timed from it. */
  readonly startedAtMs: number
  /** The last fix seen, to tell a fix from a tick. Never stored. */
  readonly fix: PositionFix | null
  /** The route the last fix was on. Never stored. */
  readonly route: RouteCandidate | null
  /** Where on that route the car was at the last fix. */
  readonly lastAlongM: number
  /** When the last fix was handed in (the drive's clock). Null before the first. */
  readonly lastMs: number | null
  /** Meters driven along the drive's routes so far. */
  readonly drivenM: number
  /** True once the car has set off (see JamOptions.setOffSpeedMps). */
  readonly moved: boolean
  /** The slow run under way. `unknown`: the kind of road was not known for some fix of it. */
  readonly run: { readonly sinceMs: number; readonly drivenM: number; readonly unknown: boolean } | null
  readonly list: readonly LoggedJam[]
  readonly count: number
  readonly jamSec: number
  readonly unknownSec: number
}

function resolve(options: Partial<JamOptions>): JamOptions {
  const d = DEFAULT_JAM_OPTIONS
  const pick = (key: keyof JamOptions) => {
    const v = options[key]
    return v !== undefined && Number.isFinite(v) && v >= 0 ? v : d[key]
  }
  return {
    jamSpeedMps: pick('jamSpeedMps'),
    minJamSec: pick('minJamSec'),
    setOffSpeedMps: pick('setOffSpeedMps'),
    maxFixGapSec: pick('maxFixGapSec'),
    maxJamsKept: Math.floor(pick('maxJamsKept')),
    drivenRoundM: Math.max(1, pick('drivenRoundM')),
  }
}

/** Stored to a tenth of a second: no more precision than the log needs. */
const tenth = (v: number) => Math.round(v * 10) / 10

/**
 * The kind of road `alongM` meters along a route with these spans. Null
 * (unknown) when the spans are null or left out, or none covers the place. A
 * place where one span ends and the next begins is on the next.
 */
export function roadKindAt(spans: readonly RoadKindSpan[] | null | undefined, alongM: number): RoadKind | null {
  if (spans === null || spans === undefined) return null
  let found: RoadKind | null = null
  for (const span of spans) {
    if (span.startM > alongM) break
    if (alongM <= span.endM) found = span.kind
  }
  return found
}

/** A new meter, for a drive that began at `startedAtMs`. */
export function startJamMeter(startedAtMs: number): JamMeter {
  return { startedAtMs, fix: null, route: null, lastAlongM: 0, lastMs: null, drivenM: 0, moved: false, run: null, list: [], count: 0, jamSec: 0, unknownSec: 0 }
}

/** The meter with its slow run closed at `endMs`: counted when it lasted minJamSec or more. */
function closeRun(meter: JamMeter, endMs: number, o: JamOptions): JamMeter {
  const run = meter.run
  if (run === null) return meter
  const durationSec = Math.max(0, (endMs - run.sinceMs) / 1000)
  if (durationSec < o.minJamSec) return { ...meter, run: null }
  if (run.unknown) return { ...meter, run: null, unknownSec: meter.unknownSec + durationSec }
  const jam: LoggedJam = {
    atSec: tenth(Math.max(0, (run.sinceMs - meter.startedAtMs) / 1000)),
    durationSec: tenth(durationSec),
    drivenM: Math.round(run.drivenM / o.drivenRoundM) * o.drivenRoundM,
  }
  return {
    ...meter,
    run: null,
    list: meter.list.length < o.maxJamsKept ? [...meter.list, jam] : meter.list,
    count: meter.count + 1,
    jamSec: meter.jamSec + durationSec,
  }
}

/**
 * Hands the meter the live drive's state at `nowMs` (the drive's clock). Only
 * a new fix of a drive under way changes anything: on a tick the same meter
 * comes back.
 *
 * - Speed: the fix's own reading, else the drive's smoothed speed.
 * - Until the car first reaches setOffSpeedMps nothing is measured.
 * - A fix under jamSpeedMps on a main road opens a slow run, or keeps one
 *   going. So does one where the kind of road is unknown (no road kind from
 *   the provider there, or the car is off the route), and the run is then
 *   marked unknown.
 * - A fix at jamSpeedMps or more, or on a side street, closes the run at that
 *   fix. A run of minJamSec or more is a jam, or unknown time when marked so;
 *   a shorter one is dropped.
 * - The time between two fixes belongs to the earlier one: a car that stands
 *   still and sends no fix for a while is still in its jam. After a gap of
 *   more than maxFixGapSec that holds only when the car's progress along the
 *   same route over the gap was under jamSpeedMps; otherwise nobody saw what
 *   the car did, and the run under way is marked unknown.
 */
export function meterJamFix(meter: JamMeter, state: LiveState, nowMs: number, options: Partial<JamOptions> = {}): JamMeter {
  const tracking = state.tracking
  const route = state.route
  if (state.status !== 'driving' || tracking === null || route === null || tracking.fix === meter.fix) return meter
  const o = resolve(options)
  const fix = tracking.fix
  const speedMps = fix.speedMps !== null && Number.isFinite(fix.speedMps) && fix.speedMps >= 0 ? fix.speedMps : tracking.speedMps
  const alongM = tracking.alongRouteM
  // Meters driven: progress along the route, added up across the routes of the drive.
  const drivenM = route === meter.route ? meter.drivenM + Math.max(0, alongM - meter.lastAlongM) : meter.drivenM
  let next: JamMeter = { ...meter, fix, route, lastAlongM: alongM, lastMs: nowMs, drivenM, moved: meter.moved || speedMps >= o.setOffSpeedMps }
  if (!next.moved) return next
  const gapSec = meter.lastMs === null ? 0 : (nowMs - meter.lastMs) / 1000
  if (next.run !== null && !next.run.unknown && gapSec > o.maxFixGapSec) {
    const crawled = route === meter.route && !tracking.offRoute && (alongM - meter.lastAlongM) / gapSec < o.jamSpeedMps
    if (!crawled) next = { ...next, run: { ...next.run, unknown: true } }
  }

  const kind = tracking.offRoute ? null : roadKindAt(route.roadKindSpansM, alongM)
  if (speedMps >= o.jamSpeedMps || kind === 'side') return closeRun(next, nowMs, o)
  const unknown = kind === null
  if (next.run === null) next = { ...next, run: { sinceMs: nowMs, drivenM, unknown } }
  else if (unknown && !next.run.unknown) next = { ...next, run: { ...next.run, unknown: true } }
  return next
}

/**
 * The drive's jams from the meter, for its record. `final`: the drive is over
 * (arrived, or End was tapped) at `nowMs`, so the slow run under way is closed
 * there; when its last fix is older than maxFixGapSec (the drive had failed,
 * or lost its position, before the tap) it is closed at that fix. Otherwise
 * (a record written mid-drive) nobody knows yet how that run ends: its time
 * so far is unknown time, so a record that is never finished does not read
 * as "no jam".
 */
export function driveJams(meter: JamMeter, nowMs: number, final: boolean, options: Partial<JamOptions> = {}): DriveJams {
  const o = resolve(options)
  const run = meter.run
  let m = meter
  if (final) {
    const stale = meter.lastMs !== null && (nowMs - meter.lastMs) / 1000 > o.maxFixGapSec
    m = closeRun(meter, stale ? meter.lastMs! : nowMs, o)
  } else if (run !== null && nowMs > run.sinceMs) {
    m = { ...meter, unknownSec: meter.unknownSec + (nowMs - run.sinceMs) / 1000 }
  }
  return { list: m.list, count: m.count, jamSec: tenth(m.jamSec), unknownSec: tenth(m.unknownSec) }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * A record's stored jams read back. Null (not measured) for a record written
 * before jams were measured, and for anything that is not jams as stored:
 * never an empty "no jams".
 */
export function parseDriveJams(raw: unknown): DriveJams | null {
  if (!isObject(raw) || !Array.isArray(raw.list)) return null
  const { count, jamSec, unknownSec } = raw
  if (!isAmount(count) || !Number.isInteger(count) || !isAmount(jamSec) || !isAmount(unknownSec)) return null
  const list: LoggedJam[] = []
  for (const j of raw.list as unknown[]) {
    if (!isObject(j) || !isAmount(j.atSec) || !isAmount(j.durationSec) || !isAmount(j.drivenM)) return null
    // Rebuilt field by field: anything else that was stored is not carried along.
    list.push({ atSec: j.atSec, durationSec: j.durationSec, drivenM: j.drivenM })
  }
  if (list.length > count) return null
  return { list, count, jamSec, unknownSec }
}

/**
 * The drive's jam time when it is known in full, in seconds: 0 really means
 * no jam. Null when it was not measured, or the kind of road was unknown for
 * some slow driving (then jamSec is only a lower bound).
 */
export function knownJamSec(jams: DriveJams | null): number | null {
  return jams === null || jams.unknownSec > 0 ? null : jams.jamSec
}

/** "45 s" under a minute, else whole minutes: "3 min". */
function jamTime(sec: number): string {
  return sec < 59.5 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`
}

/**
 * A drive's jam time in words: "6 min in 2 jams", "none", "≥ 3 min in 1 jam
 * (partial)" when some slow driving was on a road of unknown kind, "unknown"
 * when that is all there was, "not measured" for an older record.
 */
export function jamWords(jams: DriveJams | null): string {
  if (jams === null) return 'not measured'
  const counted = `${jamTime(jams.jamSec)} in ${jams.count} ${jams.count === 1 ? 'jam' : 'jams'}`
  if (jams.unknownSec > 0) return jams.count === 0 ? 'unknown' : `≥ ${counted} (partial)`
  return jams.count === 0 ? 'none' : counted
}

/** The jam time of the drives of one corridor. */
export interface CorridorJams {
  /** Arrived drives whose jam time is known in full: the ones averaged. */
  readonly drives: number
  /** Their mean jam time, in seconds. Null when there are none. */
  readonly meanJamSec: number | null
  /** Arrived drives left out: not measured, or with slow driving on a road of unknown kind. */
  readonly leftOut: number
}

/**
 * The average jam time per drive on a corridor, from its arrived drives (a
 * drive ended early is not a whole trip). A drive whose jam time is not
 * known in full is counted in `leftOut` and never averaged as 0.
 */
export function corridorJams(drives: readonly { readonly corridor: string; readonly outcome: string; readonly jams: DriveJams | null }[], corridor: string): CorridorJams {
  const arrived = drives.filter((d) => d.corridor === corridor && d.outcome === 'arrived')
  const known = arrived.map((d) => knownJamSec(d.jams)).filter((s): s is number => s !== null)
  return {
    drives: known.length,
    meanJamSec: known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length,
    leftOut: arrived.length - known.length,
  }
}

/** "4.2 min per drive on average (9 drives; 1 with unknown jam time left out)", or "no measured drives yet". */
export function corridorJamWords(c: CorridorJams): string {
  const left = c.leftOut === 0 ? '' : `${c.drives > 0 ? '; ' : ' ('}${c.leftOut} with unknown jam time left out${c.drives > 0 ? '' : ')'}`
  if (c.meanJamSec === null) return `no measured drives yet${left}`
  return `${(c.meanJamSec / 60).toFixed(1)} min per drive on average (${c.drives} ${c.drives === 1 ? 'drive' : 'drives'}${left})`
}
