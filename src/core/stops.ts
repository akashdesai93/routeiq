import type { LiveState } from './live.ts'
import type { PositionFix } from './tracking.ts'
import type { DistanceSpanM, LngLat, RouteCandidate, SignalCoverage } from './types.ts'

/**
 * Where the driver really stood still on a drive (#196, step 1): each stop's
 * length, whether it was at a known light, and the time spent on surface
 * streets against freeway. Measured during a live drive and kept in the
 * private drive log (driveLog.ts), on the device only.
 *
 * Nothing here keeps a position. A stop is kept as seconds into the drive,
 * how long it lasted, the meters driven before it, and two words (at a light
 * or not, street or freeway). The car's position is read while the drive
 * runs, as the drive itself reads it, and never stored.
 *
 * Cost per GPS fix: a few comparisons and additions and one small object,
 * no search, no storage write. The one lookup (is there a light near the
 * stop?) runs once per stop, when the car moves off.
 *
 * Pure: time comes in as arguments; the lights of a route come from a
 * function the caller passes (loaded from the same signal data as the
 * route's light count).
 */

/** Every threshold of the stop meter. See DEFAULT_STOP_OPTIONS for the values. */
export interface StopOptions {
  /**
   * Below this speed the car is stopped or crawling (a queue at a light), in
   * meters per second. The device's own speed reading when it gives one, else
   * the drive's smoothed speed (tracking.ts).
   */
  readonly crawlSpeedMps: number
  /** A stop shorter than this is not kept (a rolling turn, a moment of GPS doubt), in seconds. */
  readonly minStopSec: number
  /**
   * A stop is at a light when a light on the route lies up to this far ahead of
   * where the car last stood (the front of its wait, after any creeping), in
   * meters: the car can wait several cars back in the queue.
   */
  readonly lightAheadM: number
  /** ...or up to this far behind it: the light's point lies inside the junction, the car may have crept past it. */
  readonly lightBehindM: number
  /** At most this many stops are listed per drive. The totals count every stop. */
  readonly maxStopsKept: number
  /**
   * The street/freeway split is left out when more than this share of the
   * measured time could not be put on either (off the route, no fix on a line):
   * it would understate both parts.
   */
  readonly maxUnplacedShare: number
  /** Meters driven before a stop are stored rounded to this many meters: enough for "3.6 mi in", not a place. */
  readonly drivenRoundM: number
}

export const DEFAULT_STOP_OPTIONS: StopOptions = {
  crawlSpeedMps: 1.5,
  minStopSec: 5,
  lightAheadM: 80,
  lightBehindM: 25,
  maxStopsKept: 100,
  maxUnplacedShare: 0.1,
  drivenRoundM: 100,
}

/**
 * - 'light': a known light on the route was near the stop.
 * - 'none': none was, and the light data covers the whole route (so there is none).
 * - 'unknown': none was found, but the light data is partial or missing, or the car was off the route.
 */
export type StopPlace = 'light' | 'none' | 'unknown'

/** 'unknown' when the provider did not say what kind of road the route is on, or the car was off the route. */
export type RoadPart = 'surface' | 'freeway' | 'unknown'

/** One stop, as kept in the drive log. No position. */
export interface LoggedStop {
  /** Seconds after the drive began, when the car stopped. */
  readonly atSec: number
  readonly durationSec: number
  /** Meters driven from the start of the drive to the stop. Null when not known (off the route). */
  readonly drivenM: number | null
  readonly place: StopPlace
  readonly road: RoadPart
}

/** Time on one kind of road. */
export interface PartTime {
  /**
   * What the first route predicted for this part at the start, in seconds,
   * from the provider's per-segment times. Null when they were not sent, or
   * the drive kept a switch (it then drove another route).
   */
  readonly predictedSec: number | null
  /** Time really spent on it, in seconds. */
  readonly actualSec: number
}

/** A drive's stops, as kept in its record. */
export interface DriveStops {
  /** Every stop kept, in order; at most maxStopsKept (the totals still count all). */
  readonly list: readonly LoggedStop[]
  /** Stops, all of them. */
  readonly count: number
  /** Time stopped, all stops together, in seconds. */
  readonly stoppedSec: number
  /** Stops at a light. */
  readonly lightStops: number
  /** Time stopped at lights, in seconds. */
  readonly lightSec: number
  /** Stops where it is not known whether there was a light. Never counted as "not at a light". */
  readonly unknownStops: number
  /** Street against freeway. Null when the road class was unknown for any route of the drive. */
  readonly parts: { readonly surface: PartTime; readonly freeway: PartTime } | null
}

/** The lights of one route, as the light count found them. */
export interface RouteLights {
  /** Meters from the route start to each light (RouteSignal.atDistanceM), any order. */
  readonly alongM: readonly number[]
  readonly coverage: SignalCoverage
}

/** The lights of a route, or undefined while they are not known (still loading). */
export type LightsOf = (route: RouteCandidate) => RouteLights | undefined

/** The meter's state during a drive. In memory only: it holds the route being driven. */
export interface StopMeter {
  /** The route the last fix was on. Never stored. */
  readonly route: RouteCandidate | null
  /** The last fix seen, to tell a fix from a tick. Never stored. */
  readonly fix: PositionFix | null
  /** Meters driven on the routes before this one. */
  readonly baseM: number
  /** Where on this route the car was when it became the route. */
  readonly startAlongM: number
  /** Where on this route the car was at the last fix on its line. */
  readonly lastAlongM: number
  /** True when the last fix was on this route's line. */
  readonly lastOnLine: boolean
  /** When the last fix came (the drive's clock). */
  readonly lastMs: number | null
  /** The part of the road at the last fix: the time until the next fix goes to it. */
  readonly lastPart: RoadPart
  /** The limited-access span the car is in or before (an index into the route's spans). */
  readonly spanIndex: number
  /** The stop under way. */
  readonly open: { readonly sinceMs: number; readonly drivenM: number | null; readonly road: RoadPart } | null
  readonly list: readonly LoggedStop[]
  readonly count: number
  readonly stoppedSec: number
  readonly lightStops: number
  readonly lightSec: number
  readonly unknownStops: number
  readonly partSec: { readonly surface: number; readonly freeway: number; readonly unknown: number }
  /** True while every route of the drive said what kind of road it is on. */
  readonly classKnown: boolean
  /** True once the car has moved on this drive: a drive started while parked does not log the wait before it sets off. */
  readonly moved: boolean
  /** The first route's predicted time per part. Null when not known. */
  readonly predicted: { readonly surface: number; readonly freeway: number } | null
  /** When the drive began (the drive's clock): stops are timed from it. */
  readonly startedAtMs: number
}

function resolve(options: Partial<StopOptions>): StopOptions {
  const d = DEFAULT_STOP_OPTIONS
  const pick = (key: keyof StopOptions) => {
    const v = options[key]
    return v !== undefined && Number.isFinite(v) && v >= 0 ? v : d[key]
  }
  return {
    crawlSpeedMps: pick('crawlSpeedMps'),
    minStopSec: pick('minStopSec'),
    lightAheadM: pick('lightAheadM'),
    lightBehindM: pick('lightBehindM'),
    maxStopsKept: Math.floor(pick('maxStopsKept')),
    maxUnplacedShare: pick('maxUnplacedShare'),
    drivenRoundM: Math.max(1, pick('drivenRoundM')),
  }
}

/** Stored to a tenth of a second (and meters whole): no more precision than the log needs. */
const tenth = (v: number) => Math.round(v * 10) / 10

function inSpan(spans: readonly DistanceSpanM[], i: number, alongM: number): boolean {
  const span = spans[i]
  return span !== undefined && alongM >= span[0] && alongM <= span[1]
}

/**
 * The provider's predicted time of a route, split into street and freeway:
 * each segment's time goes to the part its middle lies on. Null unless the
 * route has both its per-segment times and its limited-access spans.
 */
export function predictedParts(route: RouteCandidate): { surface: number; freeway: number } | null {
  const durations = route.segmentTraffic?.durationSec ?? null
  const spans = route.limitedAccessSpansM
  if (durations === null || spans === null || durations.length !== route.geometry.length - 1) return null
  const parts = { surface: 0, freeway: 0 }
  let alongM = 0
  let span = 0
  for (let i = 0; i < durations.length; i++) {
    const lengthM = segmentM(route.geometry[i]!, route.geometry[i + 1]!)
    const midM = alongM + lengthM / 2
    while (span < spans.length && spans[span]![1] < midM) span++
    if (inSpan(spans, span, midM)) parts.freeway += durations[i]!
    else parts.surface += durations[i]!
    alongM += lengthM
  }
  return parts
}

/** Flat-earth length of a short segment, in meters (as accurate as the spans it is compared with). */
function segmentM(a: LngLat, b: LngLat): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180)
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * 111_195
}

/** A new meter, for a drive that began at `startedAtMs` on `route`. */
export function startStopMeter(route: RouteCandidate, startedAtMs: number): StopMeter {
  return {
    route: null,
    fix: null,
    baseM: 0,
    startAlongM: 0,
    lastAlongM: 0,
    lastOnLine: false,
    lastMs: null,
    lastPart: 'unknown',
    spanIndex: 0,
    open: null,
    list: [],
    count: 0,
    stoppedSec: 0,
    lightStops: 0,
    lightSec: 0,
    unknownStops: 0,
    partSec: { surface: 0, freeway: 0, unknown: 0 },
    classKnown: true,
    moved: false,
    predicted: predictedParts(route),
    startedAtMs,
  }
}

/** Where a stop was: at a known light, not at one, or not known. */
export function stopPlace(alongM: number | null, lights: RouteLights | undefined, options: Partial<StopOptions> = {}): StopPlace {
  if (alongM === null || lights === undefined) return 'unknown'
  const { lightAheadM, lightBehindM } = resolve(options)
  if (lights.alongM.some((m) => m >= alongM - lightBehindM && m <= alongM + lightAheadM)) return 'light'
  return lights.coverage === 'full' ? 'none' : 'unknown'
}

/** Closes the open stop at `nowMs`. Shorter than minStopSec: dropped. */
function close(meter: StopMeter, nowMs: number, alongM: number | null, lightsOf: LightsOf, opts: StopOptions): StopMeter {
  const open = meter.open
  if (open === null) return meter
  const durationSec = tenth(Math.max(0, (nowMs - open.sinceMs) / 1000))
  if (durationSec < opts.minStopSec) return { ...meter, open: null }
  const lights = meter.route === null ? undefined : lightsOf(meter.route)
  const place = stopPlace(alongM, lights, opts)
  const stop: LoggedStop = {
    atSec: tenth(Math.max(0, (open.sinceMs - meter.startedAtMs) / 1000)),
    durationSec,
    drivenM: open.drivenM === null ? null : Math.round(open.drivenM / opts.drivenRoundM) * opts.drivenRoundM,
    place,
    road: open.road,
  }
  return {
    ...meter,
    open: null,
    list: meter.list.length < opts.maxStopsKept ? [...meter.list, stop] : meter.list,
    count: meter.count + 1,
    stoppedSec: meter.stoppedSec + durationSec,
    lightStops: meter.lightStops + (place === 'light' ? 1 : 0),
    lightSec: meter.lightSec + (place === 'light' ? durationSec : 0),
    unknownStops: meter.unknownStops + (place === 'unknown' ? 1 : 0),
  }
}

/** The device's speed when it gives one, else the drive's smoothed speed. */
function speedOf(state: LiveState): number | null {
  const raw = state.lastFix?.speedMps
  if (raw !== null && raw !== undefined && Number.isFinite(raw) && raw >= 0) return raw
  return state.tracking?.speedMps ?? null
}

/**
 * Feeds the meter the live state after a change (`nowMs`: the drive's clock).
 * On anything but a new fix the same meter comes back. On a fix: the time
 * since the last one goes to the part of the road the car was on, and a stop
 * opens when the speed drops below crawlSpeedMps, or closes when it rises
 * again (then the lights of the route are asked for, once).
 */
export function meterFix(meter: StopMeter, state: LiveState, nowMs: number, lightsOf: LightsOf, options: Partial<StopOptions> = {}): StopMeter {
  if (state.lastFix === meter.fix) return meter
  const tracking = state.tracking
  const route = state.route
  const speed = speedOf(state)
  // The time since the last fix goes to the part of the road the car was on then.
  const dt = meter.lastMs !== null && nowMs > meter.lastMs ? (nowMs - meter.lastMs) / 1000 : 0
  const partSec = dt > 0 ? { ...meter.partSec, [meter.lastPart]: meter.partSec[meter.lastPart] + dt } : meter.partSec
  if (tracking === null || route === null || speed === null) return { ...meter, fix: state.lastFix, lastMs: nowMs, partSec, lastPart: 'unknown', lastOnLine: false }

  let { baseM, startAlongM, lastAlongM, spanIndex, classKnown } = meter
  // Where the car last stood, for a stop that ends on this fix: the previous fix, on this route's line.
  const stoodAtM = route === meter.route && meter.lastOnLine ? meter.lastAlongM : null
  if (route !== meter.route) {
    // A new route (a switch, a new route after leaving one): its meters start where the car is.
    if (meter.route !== null) baseM += Math.max(0, lastAlongM - startAlongM)
    startAlongM = lastAlongM = tracking.alongRouteM
    spanIndex = 0
    classKnown = classKnown && route.limitedAccessSpansM !== null
  }
  const onLine = tracking.offFixes === 0
  const alongM = tracking.alongRouteM
  const spans = route.limitedAccessSpansM
  let part: RoadPart = 'unknown'
  if (spans !== null && onLine) {
    while (spanIndex < spans.length && spans[spanIndex]![1] < alongM) spanIndex++
    part = inSpan(spans, spanIndex, alongM) ? 'freeway' : 'surface'
  }
  if (onLine) lastAlongM = alongM
  const m: StopMeter = { ...meter, fix: state.lastFix, route, lastMs: nowMs, partSec, lastPart: part, baseM, startAlongM, lastAlongM, lastOnLine: onLine, spanIndex, classKnown }

  const crawl = options.crawlSpeedMps ?? DEFAULT_STOP_OPTIONS.crawlSpeedMps
  const still = speed < (Number.isFinite(crawl) && crawl >= 0 ? crawl : DEFAULT_STOP_OPTIONS.crawlSpeedMps)
  if (!still && !m.moved) return { ...m, moved: true }
  if (still && m.open === null && m.moved) {
    const drivenM = onLine ? baseM + Math.max(0, alongM - startAlongM) : null
    return { ...m, open: { sinceMs: nowMs, drivenM, road: part } }
  }
  if (!still && m.open !== null) return close(m, nowMs, stoodAtM, lightsOf, resolve(options))
  return m
}

/**
 * The drive's stops as of `nowMs`, for its record. `final`: 'arrived' closes
 * a stop still under way (waiting at the last light before the destination);
 * 'ended' drops it (End tapped while parked is not a wait), and so does a
 * write mid-drive (it comes in the final write). `switched`: a switch was
 * kept, so the first route's prediction no longer speaks for the road driven.
 */
export function driveStops(
  meter: StopMeter,
  state: LiveState,
  nowMs: number,
  lightsOf: LightsOf,
  final: 'arrived' | 'ended' | null,
  switched: boolean,
  options: Partial<StopOptions> = {},
): DriveStops {
  const opts = resolve(options)
  let m = meter
  if (final === 'arrived' && m.open !== null) {
    // Where the car last stood, on the route whose lights are asked for; otherwise unknown.
    const alongM = state.route === m.route && m.lastOnLine ? m.lastAlongM : null
    m = close(m, nowMs, alongM, lightsOf, opts)
  }
  const predicted = switched ? null : m.predicted
  const placed = m.partSec.surface + m.partSec.freeway
  const total = placed + m.partSec.unknown
  const splitKnown = m.classKnown && m.route !== null && (total === 0 || m.partSec.unknown / total <= opts.maxUnplacedShare)
  return {
    list: m.list,
    count: m.count,
    stoppedSec: tenth(m.stoppedSec),
    lightStops: m.lightStops,
    lightSec: tenth(m.lightSec),
    unknownStops: m.unknownStops,
    parts:
      splitKnown
        ? {
            surface: { predictedSec: predicted === null ? null : tenth(predicted.surface), actualSec: tenth(m.partSec.surface) },
            freeway: { predictedSec: predicted === null ? null : tenth(predicted.freeway), actualSec: tenth(m.partSec.freeway) },
          }
        : null,
  }
}

/** Time moving: the drive's time less the time stopped. */
export function movingSec(actualSec: number, stops: DriveStops): number {
  return Math.max(0, actualSec - stops.stoppedSec)
}

/**
 * The waits at lights as far as they are known. Null when none is known to be
 * at a light and some stops' places are unknown: unknown, never "none".
 * `partial`: some stops' places are unknown, so the figures are lower bounds.
 */
export function lightTotals(stops: DriveStops): { readonly stops: number; readonly sec: number; readonly partial: boolean } | null {
  if (stops.lightStops === 0 && stops.unknownStops > 0) return null
  return { stops: stops.lightStops, sec: stops.lightSec, partial: stops.unknownStops > 0 }
}

/** True when the drive has freeway to speak of: driven, or predicted. */
export function hasFreeway(stops: DriveStops): boolean {
  const f = stops.parts?.freeway
  return f !== undefined && (f.actualSec > 0 || (f.predictedSec ?? 0) > 0)
}

/** The stops at lights, longest first: the worst `n`. */
export function worstLights(stops: DriveStops, n = 3): readonly LoggedStop[] {
  return stops.list
    .filter((s) => s.place === 'light')
    .sort((a, b) => b.durationSec - a.durationSec || a.atSec - b.atSec)
    .slice(0, n)
}
