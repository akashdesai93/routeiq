import { geometryHash } from './hash.ts'
import type { LiveState, LiveSwitch } from './live.ts'
import type { RerouteCode } from './reroute.ts'
import { driveStops, meterFix, startStopMeter, type DriveStops, type LightsOf, type LoggedStop, type StopMeter } from './stops.ts'
import type { LngLat, RouteSource, SignalCoverage } from './types.ts'

/**
 * The private drive log (#107): what each live drive predicted at its start
 * against what it really took, kept on the device only, so the owner's own
 * repeated drives can be compared over time.
 *
 * Nothing in a record says where the drive was. Its two ends become one
 * coarse corridor key: each end rounded to a grid of about a kilometre, the
 * pair hashed. No coordinate, address or place name is kept, and nothing
 * of the route's geometry (not even its id, a hash of it).
 *
 * The recorder (observeDrive, endDrive) is fed the live drive's state on
 * every change. On a 1 s tick it compares a few references and answers the
 * same recorder: it asks for a write only when a switch is made or turned
 * down, and when the drive ends.
 *
 * This module is pure: the clock's time and the local hour come in as
 * arguments, and storage lives in src/storage/driveLog.ts.
 */

/** The version of the stored shape. A new shape gets a new number (and a new storage key). */
export const DRIVE_LOG_VERSION = 1

export interface DriveLogOptions {
  /** Each end of a drive is rounded to this grid, in degrees, before the corridor key is made. 0.01° is about 1.1 km. */
  readonly corridorGridDeg: number
  /** At most this many drives are kept; the oldest go first. */
  readonly maxDrives: number
  /** Another app's ETA, as typed: whole minutes from 1 up to this. */
  readonly maxOtherAppMin: number
}

export const DEFAULT_DRIVE_LOG_OPTIONS: DriveLogOptions = {
  corridorGridDeg: 0.01,
  maxDrives: 500,
  maxOtherAppMin: 600,
}

/**
 * - 'arrived': the drive reached the destination.
 * - 'ended': End was tapped before arriving (not comparable, left out of summaries).
 * - 'unfinished': written at a switch and never ended (the app was closed during the drive).
 */
export type DriveOutcome = 'arrived' | 'ended' | 'unfinished'

export interface LoggedSwitch {
  /** Seconds after the drive began. */
  readonly atSec: number
  readonly code: RerouteCode
  /** False when the driver turned it down with "Keep previous route". */
  readonly accepted: boolean
  /** What the engine said it saves. Null when it claimed none (closure, off-route). */
  readonly claimedSavingSec: number | null
  /** The new route's predicted time from the switch on. Null when unknown. */
  readonly newRouteSec: number | null
  /**
   * The saving actually made: the time the route left was predicted to take
   * from the switch (new route's time plus the claimed saving), minus the time
   * the rest of the drive really took. Null unless it is the last switch
   * kept, a saving was claimed and the drive arrived. A prediction, not a
   * re-run of the road not taken.
   */
  readonly realisedSavingSec: number | null
  /** The source of the route switched to. */
  readonly toSource: RouteSource
}

export interface LoggedSignals {
  readonly count: number
  /** True when the count covers only part of the route: a lower bound ("≥ N"). */
  readonly partial: boolean
}

export interface DriveRecord {
  /** Unique within the log: from the time the drive began. */
  readonly id: string
  /** When the drive began on its first route (ms since the epoch). */
  readonly startedAtMs: number
  /** The local hour (0–23) at the start, as the device saw it. */
  readonly startHour: number
  /** Null while unfinished. */
  readonly endedAtMs: number | null
  /** The coarse corridor key (see corridorKey). Never a position. */
  readonly corridor: string
  /**
   * Where the first route came from. Its id is not kept: it is a hash of the
   * exact geometry, and a guessed route could be checked against it.
   */
  readonly routeSource: RouteSource
  /** The first route's traffic-aware time when the drive began. */
  readonly predictedSec: number
  /** From the start to the end (or to the last write, while unfinished). */
  readonly actualSec: number
  /** The first route's length. */
  readonly distanceM: number
  /** The first route's lights. Null when unknown (never 0 for unknown). */
  readonly signals: LoggedSignals | null
  /** Another app's ETA, as the owner typed it at departure. Null when none was noted. */
  readonly otherAppSec: number | null
  readonly switches: readonly LoggedSwitch[]
  /** Times the drive said "off the route". */
  readonly offRouteEvents: number
  /** Route requests the drive made (probes included). */
  readonly requests: number
  readonly outcome: DriveOutcome
  /**
   * Where the car stood still, and street against freeway time (see stops.ts, #196).
   * Null for a drive recorded before stops were measured: not measured, never "no stops".
   */
  readonly stops: DriveStops | null
}

export interface DriveLog {
  readonly version: typeof DRIVE_LOG_VERSION
  /** Oldest first. */
  readonly drives: readonly DriveRecord[]
}

export const EMPTY_DRIVE_LOG: DriveLog = { version: DRIVE_LOG_VERSION, drives: [] }

function resolve(options: Partial<DriveLogOptions>): DriveLogOptions {
  const d = DEFAULT_DRIVE_LOG_OPTIONS
  const positive = (v: number | undefined, fallback: number) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback)
  return {
    corridorGridDeg: positive(options.corridorGridDeg, d.corridorGridDeg),
    maxDrives: Math.floor(positive(options.maxDrives, d.maxDrives)),
    maxOtherAppMin: positive(options.maxOtherAppMin, d.maxOtherAppMin),
  }
}

/**
 * The corridor key of a drive from `origin` to `destination`: each end
 * rounded to the grid, the pair hashed. The same trip in the same direction
 * gives the same key; the way back gives another. An end near a grid line
 * can fall in the next cell, and then the drive counts as another corridor.
 */
export function corridorKey(origin: LngLat, destination: LngLat, options: Partial<DriveLogOptions> = {}): string {
  const grid = resolve(options).corridorGridDeg
  const cell = ([lng, lat]: LngLat): LngLat => [Math.round(lng / grid), Math.round(lat / grid)]
  return `c${geometryHash([cell(origin), cell(destination)]).slice(0, 12)}`
}

/** Another app's ETA as typed: "19", "19 min", or "1:05" (hours:minutes). */
export type OtherAppEta = { readonly sec: number | null; readonly problem: string | null }

export function parseOtherAppEta(text: string, options: Partial<DriveLogOptions> = {}): OtherAppEta {
  const max = resolve(options).maxOtherAppMin
  const t = text.trim().toLowerCase()
  if (t === '') return { sec: null, problem: null }
  const problem = `Type the minutes the other app showed, like 19 or 1:05 (up to ${max} minutes).`
  let minutes: number
  const clock = /^(\d{1,2}):(\d{2})$/.exec(t)
  const plain = /^(\d{1,3})\s*(m|min|mins|minutes)?$/.exec(t)
  if (clock !== null && Number(clock[2]) < 60) minutes = Number(clock[1]) * 60 + Number(clock[2])
  else if (plain !== null) minutes = Number(plain[1])
  else return { sec: null, problem }
  if (minutes < 1 || minutes > max) return { sec: null, problem }
  return { sec: minutes * 60, problem: null }
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

export interface DriveRecorder {
  /** The drive being recorded. Null before it began on a route, and after it ended. */
  readonly draft: DriveRecord | null
  /** True once the drive was written as arrived or ended: nothing more is recorded until the next one. */
  readonly done: boolean
  /** What was seen last, to tell a change from a tick. */
  readonly seen: { readonly switches: readonly LiveSwitch[]; readonly declined: number; readonly offRoute: boolean }
  /** The stops measured so far (stops.ts). In memory only; written into the record. Null before the drive began. */
  readonly meter: StopMeter | null
}

export const RECORDER_IDLE: DriveRecorder = { draft: null, done: false, seen: { switches: [], declined: 0, offRoute: false }, meter: null }

/** No lights known for any route: every stop's place is 'unknown'. */
const NO_LIGHTS: LightsOf = () => undefined

/** What the recorder needs from outside the live state, at the start of a drive. Used in memory only. */
export interface DriveContext {
  /** Another app's ETA noted at departure, in seconds. Null for none. */
  readonly otherAppSec: number | null
  /** The local hour (0–23) at `ms`. Passed in, so this module reads no clock and no time zone. */
  readonly hourOf: (ms: number) => number
}

export interface RecorderStep {
  readonly recorder: DriveRecorder
  /** The record to write now (replacing any with the same id). Null: nothing to write. */
  readonly write: DriveRecord | null
}

function signalsOf(count: number | null, coverage: SignalCoverage): LoggedSignals | null {
  if (count === null || !Number.isFinite(count) || coverage === 'none') return null
  return { count, partial: coverage !== 'full' }
}

function begin(state: LiveState, nowMs: number, context: DriveContext, options: Partial<DriveLogOptions>): DriveRecord | null {
  const route = state.route
  const fix = state.lastFix
  const destination = state.destination
  if (route === null || fix === null || destination === null) return null
  return {
    id: `d${nowMs}`,
    startedAtMs: nowMs,
    startHour: context.hourOf(nowMs),
    endedAtMs: null,
    corridor: corridorKey([fix.lng, fix.lat], destination, options),
    routeSource: route.source ?? 'provider',
    predictedSec: route.durationSec,
    actualSec: 0,
    distanceM: route.distanceM,
    signals: signalsOf(route.signalCount, route.signalCoverage),
    otherAppSec: context.otherAppSec,
    switches: [],
    offRouteEvents: 0,
    requests: state.requestsUsed,
    outcome: 'unfinished',
    stops: null,
  }
}

const elapsedSec = (draft: DriveRecord, nowMs: number) => Math.max(0, (nowMs - draft.startedAtMs) / 1000)

/**
 * The switches with their realised saving, once the drive has arrived at
 * `endMs`. Only the last kept switch gets one: its window (from the switch
 * to arrival) holds no later switch. An earlier switch's window would take
 * in the gains of the ones after it, so its realised saving stays unknown.
 */
function realise(draft: DriveRecord, endMs: number): readonly LoggedSwitch[] {
  const last = draft.switches.findLastIndex((s) => s.accepted)
  return draft.switches.map((s, i) => {
    if (i !== last || s.claimedSavingSec === null || s.newRouteSec === null) return s
    const tookSec = Math.max(0, (endMs - draft.startedAtMs) / 1000 - s.atSec)
    return { ...s, realisedSavingSec: s.newRouteSec + s.claimedSavingSec - tookSec }
  })
}

/** The record's stops from the meter. `final`: the drive is over, so a stop under way is closed. */
function withStops(draft: DriveRecord, meter: StopMeter | null, state: LiveState, nowMs: number, lightsOf: LightsOf, final: boolean): DriveRecord {
  if (meter === null) return draft
  const switched = draft.switches.some((s) => s.accepted)
  return { ...draft, stops: driveStops(meter, state, nowMs, lightsOf, final, switched) }
}

function finish(
  draft: DriveRecord,
  meter: StopMeter | null,
  state: LiveState,
  nowMs: number,
  outcome: 'arrived' | 'ended',
  lightsOf: LightsOf,
): DriveRecord {
  const done: DriveRecord = {
    ...draft,
    endedAtMs: nowMs,
    actualSec: elapsedSec(draft, nowMs),
    switches: outcome === 'arrived' ? realise(draft, nowMs) : draft.switches,
    requests: state.requestsUsed,
    outcome,
  }
  return withStops(done, meter, state, nowMs, lightsOf, true)
}

/**
 * Feeds the recorder the live drive's state after a change (`nowMs`: the
 * drive's clock then). On a tick nothing that matters changes and the same
 * recorder comes back, with nothing to write.
 *
 * - The drive beginning on its first route starts a record in memory: its
 *   corridor (from the first fix and the drive's own destination), the route's time then
 *   as the prediction, its length and lights. Nothing is written yet.
 * - A switch made, or turned down, is added and the record is written (as
 *   'unfinished'), so a drive the app does not see the end of is still kept.
 * - "Off the route" said for a new excursion is counted (no write).
 * - Arriving writes the record as 'arrived', with the real time and each
 *   kept switch's realised saving.
 * - Each new fix is handed to the stop meter (stops.ts): a few comparisons,
 *   nothing written. The stops go into the record whenever it is written.
 */
export function observeDrive(
  recorder: DriveRecorder,
  state: LiveState,
  nowMs: number,
  /** Asked for only when the drive begins on its first route, never on a tick. */
  context: () => DriveContext,
  options: Partial<DriveLogOptions> = {},
  /** The lights of a route, asked for once per stop (when the car moves off). Left out: no lights known. */
  lightsOf: LightsOf = NO_LIGHTS,
): RecorderStep {
  if (recorder.done) return { recorder, write: null }
  const seen = recorder.seen
  let draft = recorder.draft
  if (draft === null) {
    if (state.status !== 'driving') return { recorder, write: null }
    draft = begin(state, nowMs, context(), options)
    if (draft === null) return { recorder, write: null }
    const meter = meterFix(startStopMeter(state.route!, nowMs), state, nowMs, lightsOf)
    // Anything that happened before the record began is not this record's.
    return {
      recorder: { draft, done: false, seen: { switches: state.switches, declined: state.declinedSwitches, offRoute: state.offRouteNotified }, meter },
      write: null,
    }
  }

  if (state.status === 'arrived') {
    const done = finish(draft, recorder.meter, state, nowMs, 'arrived', lightsOf)
    return { recorder: { ...RECORDER_IDLE, done: true }, write: done }
  }
  if (state.status !== 'driving') return { recorder, write: null }

  const meter = recorder.meter === null ? null : meterFix(recorder.meter, state, nowMs, lightsOf)
  const switchesChanged = state.switches !== seen.switches
  const declinedChanged = state.declinedSwitches !== seen.declined
  const offRouteChanged = state.offRouteNotified !== seen.offRoute
  if (!switchesChanged && !declinedChanged && !offRouteChanged) {
    return meter === recorder.meter ? { recorder, write: null } : { recorder: { ...recorder, meter }, write: null }
  }

  let write = false
  if (offRouteChanged && state.offRouteNotified) draft = { ...draft, offRouteEvents: draft.offRouteEvents + 1 }
  if (declinedChanged && state.declinedSwitches > seen.declined) {
    // "Keep previous route" takes back the last switch made.
    const last = draft.switches.findLastIndex((s) => s.accepted)
    if (last >= 0) {
      draft = { ...draft, switches: draft.switches.map((s, i) => (i === last ? { ...s, accepted: false } : s)) }
      write = true
    }
  } else if (switchesChanged && state.switches.length > seen.switches.length) {
    const added = state.switches.slice(seen.switches.length).map(
      (s): LoggedSwitch => ({
        atSec: Math.max(0, (s.atMs - draft!.startedAtMs) / 1000),
        code: s.code,
        accepted: true,
        claimedSavingSec: s.savingSec,
        newRouteSec: state.eta?.durationSec ?? null,
        realisedSavingSec: null,
        toSource: state.route?.source ?? 'provider',
      }),
    )
    draft = { ...draft, switches: [...draft.switches, ...added] }
    write = true
  }
  if (write) draft = withStops({ ...draft, actualSec: elapsedSec(draft, nowMs), requests: state.requestsUsed }, meter, state, nowMs, lightsOf, false)
  return {
    recorder: { draft, done: false, seen: { switches: state.switches, declined: state.declinedSwitches, offRoute: state.offRouteNotified }, meter },
    write: write ? draft : null,
  }
}

/**
 * The End tap (or the drive view closed), with the last state before it.
 * A drive that began on a route and has not arrived is written as 'ended';
 * otherwise there is nothing to write.
 */
export function endDrive(recorder: DriveRecorder, state: LiveState, nowMs: number, lightsOf: LightsOf = NO_LIGHTS): RecorderStep {
  if (recorder.done || recorder.draft === null) return { recorder: { ...RECORDER_IDLE, done: true }, write: null }
  return { recorder: { ...RECORDER_IDLE, done: true }, write: finish(recorder.draft, recorder.meter, state, nowMs, 'ended', lightsOf) }
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/** The log with `record` in it: replacing the one with its id, or added in start order. The oldest beyond maxDrives go. */
export function recordDrive(log: DriveLog, record: DriveRecord, options: Partial<DriveLogOptions> = {}): DriveLog {
  const { maxDrives } = resolve(options)
  const others = log.drives.filter((d) => d.id !== record.id)
  const drives = [...others, record].sort((a, b) => a.startedAtMs - b.startedAtMs)
  return { version: DRIVE_LOG_VERSION, drives: drives.slice(Math.max(0, drives.length - maxDrives)) }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v)
const isSource = (v: unknown): v is RouteSource => v === 'provider' || v === 'probe'
/** A reroute code as stored: kept as text, so a code added later still reads back. */
const isCode = (v: unknown): v is RerouteCode => typeof v === 'string' && /^[a-z-]{1,40}$/.test(v)

function parseSwitch(raw: unknown): LoggedSwitch | null {
  if (!isObject(raw)) return null
  const { atSec, code, accepted, claimedSavingSec, newRouteSec, realisedSavingSec, toSource } = raw
  if (!isNum(atSec) || !isCode(code) || typeof accepted !== 'boolean') return null
  if (!isNumOrNull(claimedSavingSec) || !isNumOrNull(newRouteSec) || !isNumOrNull(realisedSavingSec) || !isSource(toSource)) return null
  return { atSec, code, accepted, claimedSavingSec, newRouteSec, realisedSavingSec, toSource }
}

const isPlace = (v: unknown): v is LoggedStop['place'] => v === 'light' || v === 'none' || v === 'unknown'
const isRoad = (v: unknown): v is LoggedStop['road'] => v === 'surface' || v === 'freeway' || v === 'unknown'
const isCount = (v: unknown): v is number => isNum(v) && v >= 0

function parseStop(raw: unknown): LoggedStop | null {
  if (!isObject(raw)) return null
  const { atSec, durationSec, drivenM, place, road } = raw
  if (!isCount(atSec) || !isCount(durationSec) || !isNumOrNull(drivenM) || !isPlace(place) || !isRoad(road)) return null
  return { atSec, durationSec, drivenM, place, road }
}

function parsePart(raw: unknown): { predictedSec: number | null; actualSec: number } | null {
  if (!isObject(raw) || !isNumOrNull(raw.predictedSec) || !isCount(raw.actualSec)) return null
  return { predictedSec: raw.predictedSec, actualSec: raw.actualSec }
}

/** A record's stops read back. Undefined when they are damaged (the record is then dropped); null when not measured. */
function parseStops(raw: unknown): DriveStops | null | undefined {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw) || !Array.isArray(raw.list)) return undefined
  const { count, stoppedSec, lightStops, lightSec, unknownStops } = raw
  if (!isCount(count) || !isCount(stoppedSec) || !isCount(lightStops) || !isCount(lightSec) || !isCount(unknownStops)) return undefined
  const list = raw.list.map(parseStop)
  if (list.some((s) => s === null)) return undefined
  let parts: DriveStops['parts'] = null
  if (raw.parts !== null) {
    if (!isObject(raw.parts)) return undefined
    const surface = parsePart(raw.parts.surface)
    const freeway = parsePart(raw.parts.freeway)
    if (surface === null || freeway === null) return undefined
    parts = { surface, freeway }
  }
  return { list: list as LoggedStop[], count, stoppedSec, lightStops, lightSec, unknownStops, parts }
}

function parseRecord(raw: unknown): DriveRecord | null {
  if (!isObject(raw)) return null
  const r = raw
  if (typeof r.id !== 'string' || !/^d\d+$/.test(r.id)) return null
  if (typeof r.corridor !== 'string' || !/^c[0-9a-f]{12}$/.test(r.corridor)) return null
  if (!isSource(r.routeSource)) return null
  if (!isNum(r.startedAtMs) || !isNumOrNull(r.endedAtMs) || !isNum(r.startHour) || r.startHour < 0 || r.startHour > 23) return null
  if (!isNum(r.predictedSec) || !isNum(r.actualSec) || !isNum(r.distanceM) || !isNumOrNull(r.otherAppSec)) return null
  if (!isNum(r.offRouteEvents) || !isNum(r.requests)) return null
  if (r.outcome !== 'arrived' && r.outcome !== 'ended' && r.outcome !== 'unfinished') return null
  let signals: LoggedSignals | null = null
  if (r.signals !== null) {
    if (!isObject(r.signals) || !isNum(r.signals.count) || typeof r.signals.partial !== 'boolean') return null
    signals = { count: r.signals.count, partial: r.signals.partial }
  }
  if (!Array.isArray(r.switches)) return null
  const switches = r.switches.map(parseSwitch)
  if (switches.some((s) => s === null)) return null
  // A record from before stops were measured has none: read as not measured.
  const stops = parseStops(r.stops)
  if (stops === undefined) return null
  // Rebuilt field by field: anything else that was stored is not carried along.
  return {
    id: r.id,
    startedAtMs: r.startedAtMs,
    startHour: r.startHour,
    endedAtMs: r.endedAtMs,
    corridor: r.corridor,
    routeSource: r.routeSource,
    predictedSec: r.predictedSec,
    actualSec: r.actualSec,
    distanceM: r.distanceM,
    signals,
    otherAppSec: r.otherAppSec,
    switches: switches as LoggedSwitch[],
    offRouteEvents: r.offRouteEvents,
    requests: r.requests,
    outcome: r.outcome,
    stops,
  }
}

/**
 * A stored log read back. Null when it is not a log of this version at all;
 * a damaged record inside a good log is dropped by itself.
 */
export function parseDriveLog(raw: unknown): DriveLog | null {
  if (!isObject(raw) || raw.version !== DRIVE_LOG_VERSION || !Array.isArray(raw.drives)) return null
  const drives = raw.drives.map(parseRecord).filter((d): d is DriveRecord => d !== null)
  return { version: DRIVE_LOG_VERSION, drives: [...drives].sort((a, b) => a.startedAtMs - b.startedAtMs) }
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/** The median, or null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** How far off the prediction was: positive when the drive took longer than predicted. Null unless it arrived. */
export function predictionErrorSec(drive: DriveRecord): number | null {
  return drive.outcome === 'arrived' ? drive.actualSec - drive.predictedSec : null
}

/** The same for the other app's ETA. Null unless it arrived and one was noted. */
export function otherAppErrorSec(drive: DriveRecord): number | null {
  return drive.outcome === 'arrived' && drive.otherAppSec !== null ? drive.actualSec - drive.otherAppSec : null
}

export interface ErrorGroup<K> {
  readonly key: K
  /** Arrived drives in the group. */
  readonly drives: number
  /** Median of actual minus predicted. Positive: RouteIQ under-estimated (the drive took longer). */
  readonly medianErrorSec: number
}

export interface CorridorSummary {
  readonly corridor: string
  /** "A", "B", ...: by the corridor's first drive in the log. */
  readonly label: string
  /** Every drive on the corridor, whatever its outcome. */
  readonly drives: number
  /** Arrived drives: the only ones compared. */
  readonly arrived: number
  /** Null when none arrived. */
  readonly medianErrorSec: number | null
  /** By local hour of the start, earliest hour first. */
  readonly byHour: readonly ErrorGroup<number>[]
  /** By the source of the first route. */
  readonly bySource: readonly ErrorGroup<RouteSource>[]
  /** The other app's ETA on the drives where one was noted. Null when none. */
  readonly otherApp: ErrorGroup<'other-app'> | null
}

/** A letter per corridor, by its first drive in the log: A, B, ... Z, AA, AB, ... */
export function corridorLabels(log: DriveLog): ReadonlyMap<string, string> {
  const labels = new Map<string, string>()
  const name = (n: number): string => (n < 26 ? String.fromCharCode(65 + n) : name(Math.floor(n / 26) - 1) + name(n % 26))
  for (const d of log.drives) if (!labels.has(d.corridor)) labels.set(d.corridor, name(labels.size))
  return labels
}

function groups<K>(drives: readonly DriveRecord[], keyOf: (d: DriveRecord) => K, errorOf: (d: DriveRecord) => number | null): ErrorGroup<K>[] {
  const by = new Map<K, number[]>()
  for (const d of drives) {
    const e = errorOf(d)
    if (e === null) continue
    const k = keyOf(d)
    by.set(k, [...(by.get(k) ?? []), e])
  }
  return [...by].map(([key, errors]) => ({ key, drives: errors.length, medianErrorSec: median(errors)! }))
}

/** One summary per corridor, in label order. Only arrived drives are compared; the rest are only counted. */
export function summarizeDriveLog(log: DriveLog): readonly CorridorSummary[] {
  const labels = corridorLabels(log)
  return [...labels].map(([corridor, label]) => {
    const all = log.drives.filter((d) => d.corridor === corridor)
    const errors = all.map(predictionErrorSec).filter((e): e is number => e !== null)
    const other = groups(all, () => 'other-app' as const, otherAppErrorSec)
    return {
      corridor,
      label,
      drives: all.length,
      arrived: errors.length,
      medianErrorSec: median(errors),
      byHour: groups(all, (d) => d.startHour, predictionErrorSec).sort((a, b) => a.key - b.key),
      bySource: groups(all, (d) => d.routeSource, predictionErrorSec).sort((a, b) => a.key.localeCompare(b.key)),
      otherApp: other[0] ?? null,
    }
  })
}

/** "8 am", "12 pm", "5 pm". */
export function hourLabel(hour: number): string {
  const h = ((Math.round(hour) % 24) + 24) % 24
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'am' : 'pm'}`
}

/** "on time", "2 min longer than predicted", "1 min shorter than predicted" (to the nearest minute). */
export function errorWords(errorSec: number): string {
  const min = Math.round(errorSec / 60)
  if (min === 0) return 'on time'
  return `${Math.abs(min)} min ${min > 0 ? 'longer' : 'shorter'} than predicted`
}

const csvMin = (sec: number | null) => (sec === null ? '' : (sec / 60).toFixed(1))

export const DRIVE_LOG_CSV_HEADER =
  'started,corridor,hour,outcome,route_source,predicted_min,actual_min,error_min,other_app_min,other_app_error_min,distance_km,lights,switches_kept,switches_declined,claimed_saving_min,realised_saving_min,off_route,requests,stopped_min,light_stops,light_wait_min'

/**
 * The log as CSV, oldest first, for the share sheet or the clipboard. The
 * start time is UTC (ISO 8601) and the hour is the device's local hour.
 * Corridors are their letters; lights are blank when unknown and "≥N" when partial.
 * The stop columns are blank for a drive recorded before stops were measured.
 */
export function driveLogCsv(log: DriveLog): string {
  const labels = corridorLabels(log)
  const rows = log.drives.map((d) => {
    const kept = d.switches.filter((s) => s.accepted)
    const claimed = kept.map((s) => s.claimedSavingSec).filter((v): v is number => v !== null)
    const realised = kept.map((s) => s.realisedSavingSec).filter((v): v is number => v !== null)
    const sum = (v: number[]) => (v.length === 0 ? null : v.reduce((a, b) => a + b, 0))
    return [
      new Date(d.startedAtMs).toISOString(),
      labels.get(d.corridor) ?? '',
      String(d.startHour),
      d.outcome,
      d.routeSource,
      csvMin(d.predictedSec),
      csvMin(d.actualSec),
      csvMin(predictionErrorSec(d)),
      csvMin(d.otherAppSec),
      csvMin(otherAppErrorSec(d)),
      (d.distanceM / 1000).toFixed(1),
      d.signals === null ? '' : `${d.signals.partial ? '≥' : ''}${d.signals.count}`,
      String(kept.length),
      String(d.switches.length - kept.length),
      csvMin(sum(claimed)),
      csvMin(sum(realised)),
      String(d.offRouteEvents),
      String(d.requests),
      csvMin(d.stops?.stoppedSec ?? null),
      d.stops === null ? '' : String(d.stops.lightStops),
      csvMin(d.stops?.lightSec ?? null),
    ].join(',')
  })
  return [DRIVE_LOG_CSV_HEADER, ...rows].join('\n')
}
