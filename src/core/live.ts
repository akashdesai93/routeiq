import { isValidLngLat, lineFrom } from './geo.ts'
import { armGuidance, dueAnnouncement, nextTurn, type GuidanceCursor, type NextTurn } from './guidance.ts'
import {
  checkProbeAllowance,
  INITIAL_CHECK_PROBES,
  rememberCheckProbes,
  resolveDriveProbeBudget,
  type CheckProbeMemory,
  type DriveProbeBudget,
} from './probe.ts'
import { rankRoutes } from './rank.ts'
import {
  decideReroute,
  declineRoute,
  DEFAULT_REROUTE_OPTIONS,
  INITIAL_REROUTE_STATE,
  spokenDistance,
  spokenDuration,
  type RerouteCode,
  type RerouteOptions,
  type RerouteState,
} from './reroute.ts'
import type { SpokenLine } from './speechQueue.ts'
import {
  DEFAULT_TRACKING_OPTIONS,
  isUsableFix,
  retrack,
  trackedRoute,
  trackFix,
  type PositionFix,
  type TrackingOptions,
  type TrackingState,
} from './tracking.ts'
import type { LngLat, RouteCandidate } from './types.ts'

/**
 * The live drive: the reroute engine (reroute.ts) fed by the device's real
 * position. One tap starts it; after that it follows the car, checks for
 * faster routes on a timer, changes route by itself and says so.
 *
 * A pure state machine: `liveStep(state, event, options)` answers the next
 * state and a list of effects (watch the position, ask for routes, speak,
 * hold the screen awake). It reads no clock and touches no device: every
 * event carries its time, and src/live/runner.ts carries the effects out. A
 * native shell runs the same machine with its own position source, voice and
 * screen lock.
 *
 * The position is used in memory only. Nothing here stores or logs it.
 */

export type LiveStatus =
  /** No drive. */
  | 'idle'
  /** Started; waiting for the first good position fix. */
  | 'locating'
  /** Has a position; waiting for the first route. */
  | 'planning'
  | 'driving'
  | 'arrived'
  /** Could not start, or cannot go on: `message` says why. */
  | 'failed'

/** Every setting of the live drive, in one place. See DEFAULT_LIVE_OPTIONS for the values. */
export interface LiveOptions {
  /** A check for faster routes is due every this many seconds. */
  readonly pollIntervalSec: number
  /** No two route requests closer together than this, whatever asks for them, in seconds. Also the floor of pollIntervalSec. */
  readonly minRequestGapSec: number
  /** After standing still for this long, no checks are made until the car moves again, in seconds. */
  readonly stationaryPauseSec: number
  /** The most route requests one drive may make (the first route and every check). After that it drives on without checking. */
  readonly maxRequests: number
  /** Requests kept back, on top of maxRequests, for finding a new route when off the route. */
  readonly offRouteReserve: number
  /** No check is sent from a position older than this, in seconds (a tunnel): it would be asked from the wrong place. */
  readonly maxFixAgeSec: number
  /** How long the "switched route" banner and its "Keep previous route" button stay, in seconds. */
  readonly switchBannerSec: number
  /** A spell in the background shorter than this is not mentioned, in seconds. */
  readonly hiddenNoteMinSec: number
  /** How long the "was paused in the background" note stays, in seconds. */
  readonly pausedNoteSec: number
  /** While still off the route after a new one was found, another is looked for no sooner than this, in seconds. */
  readonly replanGapSec: number
  /** Below this speed the device's heading is not sent with a request, in meters per second: standing still it points anywhere. */
  readonly minHeadingSpeedMps: number
  readonly tracking: Partial<TrackingOptions>
  readonly reroute: Partial<RerouteOptions>
  /** Side-street probes during the checks (probe.ts, DEFAULT_DRIVE_PROBE_BUDGET); they share maxRequests. */
  readonly probes: Partial<DriveProbeBudget>
}

export const DEFAULT_LIVE_OPTIONS: LiveOptions = {
  pollIntervalSec: 60,
  minRequestGapSec: 10,
  stationaryPauseSec: 120,
  maxRequests: 60,
  offRouteReserve: 5,
  maxFixAgeSec: 10,
  switchBannerSec: 8,
  hiddenNoteMinSec: 5,
  pausedNoteSec: 15,
  replanGapSec: 30,
  minHeadingSpeedMps: 2,
  tracking: {},
  reroute: {},
  probes: {},
}

/** Why a position could not be had. The same kinds as the geolocation wrapper's. */
export type PositionErrorKind = 'denied' | 'unavailable' | 'timeout' | 'insecure' | 'unsupported'

/** What the driver is told for each kind. The first three keep trying or need the driver; the text says which. */
export const POSITION_ERROR_MESSAGES: Readonly<Record<PositionErrorKind, string>> = {
  denied:
    'Location permission was denied. RouteIQ cannot follow the drive without it. Allow location for this site in the browser settings, then start again.',
  unavailable: 'Your position is not available right now. Still trying.',
  timeout: 'No position fix yet. Still trying: this can take a while indoors.',
  insecure: 'Browsers only share location on secure pages (HTTPS or localhost), so a live drive cannot start here.',
  unsupported: 'This browser cannot share its location, so a live drive cannot start here.',
}

const FATAL: ReadonlySet<PositionErrorKind> = new Set<PositionErrorKind>(['denied', 'insecure', 'unsupported'])

/** What a route request is for. */
export type RequestPurpose = 'plan' | 'poll' | 'replan'

export type WakeLockStatus = 'pending' | 'held' | 'unavailable' | 'released'

export interface LiveSwitch {
  readonly atMs: number
  readonly code: RerouteCode
  /** The engine's sentence for it. */
  readonly reason: string
  /**
   * The time the engine said the switch saves, in seconds: the fresh time of
   * the route left minus that of the new one. Null when it claimed none (a
   * closure ahead, a new route after leaving the old one).
   */
  readonly savingSec: number | null
}

export interface LiveSummary {
  /** From the Start tap to arrival, in seconds. */
  readonly tripSec: number
  /** The route changes that were made and kept, in order. */
  readonly switches: readonly LiveSwitch[]
  /** Switches the driver turned down with "Keep previous route". */
  readonly declined: number
  readonly requestsUsed: number
}

/** The whole of a live drive between two events. Plain data: keep it, pass it back, never edit it. */
export interface LiveState {
  readonly status: LiveStatus
  readonly destination: LngLat | null
  readonly startedAtMs: number | null
  /**
   * The route picked on the plan screen, handed over at Start (a side-street
   * probe route included). The drive starts on it when the first good fix is
   * on its line; otherwise it asks for a route from where the car is. Kept
   * until then only.
   */
  readonly picked: RouteCandidate | null
  /** Why the drive failed. Null otherwise. */
  readonly message: string | null
  /** A passing note about the position (no fix yet, poor accuracy). Null when there is none. */
  readonly gpsNote: string | null
  /** The last usable fix. In memory only. */
  readonly lastFix: PositionFix | null
  /** The route being driven. */
  readonly route: RouteCandidate | null
  readonly tracking: TrackingState | null
  readonly engine: RerouteState
  readonly guidance: GuidanceCursor
  /** The route request that is out. */
  readonly request: {
    readonly id: number
    readonly purpose: RequestPurpose
    readonly sentAtMs: number
    /** Where along the route the car was when it was sent: the engine is asked about that place. */
    readonly alongM: number
    readonly distanceFromRouteM: number
    /** Requests made for it after the first (its path check, its probes), counted as the shell sent them. */
    readonly extraSent?: number
    /** How many of those were side-street probes. */
    readonly probesSent?: number
  } | null
  readonly nextRequestId: number
  /** Route requests made so far on this drive (side-street probes included). */
  readonly requestsUsed: number
  /** The side-street probes of the checks: how many were made, whose turn is next, and the via being confirmed. */
  readonly probes: CheckProbeMemory
  readonly lastRequestAtMs: number | null
  /** When the last check was answered. Null before the first route. */
  readonly lastCheckedAtMs: number | null
  /** A check is wanted as soon as one may be sent (back from the background). */
  readonly recheck: boolean
  /** The engine's latest word. */
  readonly lastDecision: { readonly action: 'stay' | 'switch'; readonly code: RerouteCode | 'kept-previous'; readonly reason: string; readonly atMs: number } | null
  /** What the last answered check returned. */
  readonly candidates: readonly RouteCandidate[] | null
  /** The travel time last heard for the route being driven, and how much of the route it was for. */
  readonly eta: { readonly durationSec: number; readonly remainingM: number } | null
  /** Where a switch that is waiting (pending) or was just made leaves the old route. */
  readonly turn: { readonly at: LngLat; readonly pending: boolean } | null
  /** Shown for a few seconds after a switch. */
  readonly switchBanner: { readonly untilMs: number; readonly text: string; readonly canKeep: boolean } | null
  /** What "Keep previous route" goes back to, while the banner is up. */
  readonly undo: {
    readonly route: RouteCandidate
    readonly alongM: number
    readonly engine: RerouteState
    readonly eta: LiveState['eta']
  } | null
  readonly switches: readonly LiveSwitch[]
  readonly declinedSwitches: number
  /** True once "off the route" has been said for the present excursion (it ends with a fix back on a route line). */
  readonly offRouteNotified: boolean
  /** New routes asked for during the present excursion. */
  readonly offRouteReplans: number
  /** Since when the page has been in the background. Null while it is in front. */
  readonly hiddenSinceMs: number | null
  readonly pausedNote: { readonly seconds: number; readonly untilMs: number } | null
  readonly wakeLock: WakeLockStatus
  readonly muted: boolean
  readonly summary: LiveSummary | null
}

export const LIVE_IDLE: LiveState = {
  status: 'idle',
  destination: null,
  startedAtMs: null,
  picked: null,
  message: null,
  gpsNote: null,
  lastFix: null,
  route: null,
  tracking: null,
  engine: INITIAL_REROUTE_STATE,
  guidance: { next: 0 },
  request: null,
  nextRequestId: 1,
  requestsUsed: 0,
  probes: INITIAL_CHECK_PROBES,
  lastRequestAtMs: null,
  lastCheckedAtMs: null,
  recheck: false,
  lastDecision: null,
  candidates: null,
  eta: null,
  turn: null,
  switchBanner: null,
  undo: null,
  switches: [],
  declinedSwitches: 0,
  offRouteNotified: false,
  offRouteReplans: 0,
  hiddenSinceMs: null,
  pausedNote: null,
  wakeLock: 'pending',
  muted: false,
  summary: null,
}

export type LiveEvent =
  /**
   * The Start tap. `route`: the route picked on the plan screen, to be driven
   * (see LiveState.picked). Left out or null: the drive asks for its own.
   */
  | { readonly type: 'start'; readonly nowMs: number; readonly destination: LngLat; readonly route?: RouteCandidate | null }
  | { readonly type: 'fix'; readonly nowMs: number; readonly fix: PositionFix }
  | { readonly type: 'position-error'; readonly nowMs: number; readonly kind: PositionErrorKind }
  /**
   * The answer to a 'request-routes' effect. `routes` null: the request failed (`message` says how).
   * `baseline`: what came back when the current path itself was asked for (see the effect's
   * `baseline` and RerouteObservation.baseline); left out or null when it was not asked or failed.
   * `requests`: how many requests the answer took, when more than the one the effect counted.
   * `probes`: how many of those were side-street probes (see the effect's `probes`); left out, none.
   */
  | {
      readonly type: 'routes'
      readonly nowMs: number
      readonly requestId: number
      readonly routes: readonly RouteCandidate[] | null
      readonly message?: string
      readonly baseline?: readonly RouteCandidate[] | null
      readonly requests?: number
      readonly probes?: number
    }
  /**
   * The shell is sending one more request for the check `requestId` (its path
   * check, or a side-street probe, or the path check a probe needs). Counted
   * at once, so a check that is cancelled afterwards still counts every request
   * it made, whether or not its answer is ever used.
   */
  | { readonly type: 'request-sent'; readonly requestId: number; readonly probe: boolean }
  /** About once a second. */
  | { readonly type: 'tick'; readonly nowMs: number }
  | { readonly type: 'visibility'; readonly nowMs: number; readonly hidden: boolean }
  | { readonly type: 'wake-lock'; readonly result: 'held' | 'unavailable' | 'released' }
  /** The driver pressed "Keep previous route". */
  | { readonly type: 'keep-previous'; readonly nowMs: number }
  | { readonly type: 'mute'; readonly muted: boolean }
  /** The End tap, or the drive view being closed. */
  | { readonly type: 'end' }

export type LiveEffect =
  | { readonly type: 'watch-position' }
  | { readonly type: 'stop-watching' }
  | { readonly type: 'acquire-wake-lock' }
  | { readonly type: 'release-wake-lock' }
  | {
      readonly type: 'request-routes'
      readonly requestId: number
      readonly purpose: RequestPurpose
      readonly origin: LngLat
      /** The direction of travel to send with the request. Null: none (standing still, or unknown). */
      readonly headingDeg: number | null
      /**
       * True when the shell may spend ONE more request on this check: if the
       * fresh routes do not include the route being driven, it asks for that
       * path itself (baselineProbe) and answers with it as `baseline`. False
       * when the request budget has no room for it, and for anything but a check.
       */
      readonly baseline: boolean
      /**
       * The side-street probes the shell may make on this check (PLAN step
       * 11c): at most `allowed` requests, through the via points core
       * checkProbes picks from the fresh routes with `memory`. Each probed
       * route that is new comes back among `routes`, tagged source 'probe'
       * with its via. `allowed` is 0 for anything but a check, and when the
       * budget has no room (checkProbeAllowance).
       */
      readonly probes: { readonly allowed: number; readonly memory: CheckProbeMemory; readonly budget: DriveProbeBudget }
    }
  | { readonly type: 'cancel-request' }
  | { readonly type: 'speak'; readonly line: SpokenLine }
  /** Said inside the Start tap, which is what lets a phone browser speak later; silent when muted. */
  | { readonly type: 'prime-speech'; readonly text: string }
  | { readonly type: 'stop-speaking' }
  | { readonly type: 'set-muted'; readonly muted: boolean }
  /** The route being driven changed: for a position source that follows it (the replay). */
  | { readonly type: 'follow-route'; readonly geometry: readonly LngLat[] }

export interface LiveStep {
  readonly state: LiveState
  readonly effects: readonly LiveEffect[]
}

// The lines that are spoken. Turn prompts come from the route's guidance.
export const SPOKEN = {
  started: 'RouteIQ started',
  offRoute: 'You are off the route. Finding a new one.',
  keptPrevious: 'Keeping the previous route.',
} as const

function times(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`
}

/**
 * "Switching to a faster route. Saves 3 minutes. Turn in 0.8 miles." and its relatives.
 * `sideStreet`: the new route was found by a side-street probe, and the line says so.
 */
export function switchLine(
  code: RerouteCode,
  savingSec: number | null,
  turnInM: number | null,
  newDurationSec: number,
  sideStreet = false,
): string {
  const turn = turnInM === null ? '' : ` Turn in ${spokenDistance(turnInM)}.`
  if (code === 'off-route') return `New route. ${spokenDuration(newDurationSec)} to your destination.`
  if (code === 'faster-route' && savingSec !== null) {
    return `Switching to a faster route${sideStreet ? ' via side streets' : ''}. Saves ${spokenDuration(savingSec)}.${turn}`
  }
  // The only other switch (route-lost): asked several times, the provider found no route along the road ahead.
  return `Switching routes. The road ahead on your route looks closed.${turn}`
}

export function arrivalLine(summary: LiveSummary): string {
  const changed = summary.switches.length === 0 ? '' : ` RouteIQ changed route ${times(summary.switches.length)}.`
  return `You have arrived. Trip time ${spokenDuration(summary.tripSec)}.${changed}`
}

function resolve(options: Partial<LiveOptions>): LiveOptions {
  const d = DEFAULT_LIVE_OPTIONS
  const n = (v: number | undefined, fallback: number) => (v !== undefined && Number.isFinite(v) && v >= 0 ? v : fallback)
  const minRequestGapSec = Math.max(d.minRequestGapSec, n(options.minRequestGapSec, d.minRequestGapSec))
  return {
    // Never faster than the request gap, whatever is typed into a settings box.
    pollIntervalSec: Math.max(minRequestGapSec, n(options.pollIntervalSec, d.pollIntervalSec)),
    minRequestGapSec,
    stationaryPauseSec: n(options.stationaryPauseSec, d.stationaryPauseSec),
    maxRequests: Math.round(n(options.maxRequests, d.maxRequests)),
    offRouteReserve: Math.round(n(options.offRouteReserve, d.offRouteReserve)),
    maxFixAgeSec: n(options.maxFixAgeSec, d.maxFixAgeSec),
    switchBannerSec: n(options.switchBannerSec, d.switchBannerSec),
    hiddenNoteMinSec: n(options.hiddenNoteMinSec, d.hiddenNoteMinSec),
    pausedNoteSec: n(options.pausedNoteSec, d.pausedNoteSec),
    replanGapSec: Math.max(minRequestGapSec, n(options.replanGapSec, d.replanGapSec)),
    minHeadingSpeedMps: n(options.minHeadingSpeedMps, d.minHeadingSpeedMps),
    tracking: options.tracking ?? d.tracking,
    reroute: options.reroute ?? d.reroute,
    probes: options.probes ?? d.probes,
  }
}

/** Whether a check for faster routes may be sent now, and if not, what it is waiting for. */
export type LivePollGate =
  | 'due'
  | 'not-driving'
  | 'in-flight'
  /** The page is in the background. */
  | 'hidden'
  | 'budget-spent'
  /** Too soon after the last request. */
  | 'request-gap'
  | 'not-yet'
  /** Standing still for longer than stationaryPauseSec. */
  | 'stationary'
  /** The last position is too old (a tunnel). */
  | 'no-fix'
  /** The last fix was off the route line: a check from there would not be about this route. */
  | 'off-line'

/**
 * The poll rule. A check is due `pollIntervalSec` after the last request, or
 * at once when one is wanted (back from the background); never within
 * `minRequestGapSec` of the last request, never with the budget spent, never
 * while the page is hidden, never from a stale position or one off the
 * route line, and not while the car has stood still for more than
 * `stationaryPauseSec`.
 */
export function livePollGate(state: LiveState, nowMs: number, options: Partial<LiveOptions> = {}): LivePollGate {
  const opts = resolve(options)
  if (state.status !== 'driving' || state.tracking === null || state.route === null) return 'not-driving'
  if (state.request !== null) return 'in-flight'
  if (state.hiddenSinceMs !== null) return 'hidden'
  if (!(state.requestsUsed < opts.maxRequests)) return 'budget-spent'
  // A drive that started on the route picked on the plan screen has made no request yet:
  // that route's answer counts as the first one, so the first check is a poll interval later.
  const lastAskedMs = state.lastRequestAtMs ?? state.lastCheckedAtMs
  const sinceRequestSec = lastAskedMs === null ? Infinity : (nowMs - lastAskedMs) / 1000
  if (sinceRequestSec < opts.minRequestGapSec) return 'request-gap'
  if (!state.recheck && sinceRequestSec < opts.pollIntervalSec) return 'not-yet'
  if ((nowMs - state.tracking.fix.timeMs) / 1000 > opts.maxFixAgeSec) return 'no-fix'
  if (state.tracking.offFixes > 0) return 'off-line'
  const stoppedSince = state.tracking.stoppedSinceMs
  if (stoppedSince !== null && (nowMs - stoppedSince) / 1000 > opts.stationaryPauseSec) return 'stationary'
  return 'due'
}

const STOP_EFFECTS: readonly LiveEffect[] = [{ type: 'cancel-request' }, { type: 'stop-watching' }, { type: 'release-wake-lock' }]

function fail(state: LiveState, message: string): LiveStep {
  return { state: { ...state, status: 'failed', message, request: null, switchBanner: null, undo: null }, effects: STOP_EFFECTS }
}

/** A route with a line to drive. */
function drivable(route: RouteCandidate | null | undefined): route is RouteCandidate {
  return route != null && route.geometry.filter(isValidLngLat).length >= 2
}

function headingFor(tracking: TrackingState, opts: LiveOptions): number | null {
  return tracking.speedMps >= opts.minHeadingSpeedMps ? tracking.headingDeg : null
}

/** Sends a route request from where the car is. The caller has checked that one may be sent. */
function request(state: LiveState, purpose: RequestPurpose, nowMs: number, opts: LiveOptions): LiveStep {
  const tracking = state.tracking
  const fix = state.lastFix
  if (fix === null) return { state, effects: [] }
  const id = state.nextRequestId
  // On the route: ask from the point on its line, so the fresh routes start on it.
  // Off it (or before there is a route): from the fix itself.
  const origin: LngLat = tracking !== null && purpose === 'poll' ? tracking.position : [fix.lng, fix.lat]
  const headingDeg =
    tracking !== null
      ? headingFor(tracking, opts)
      : fix.speedMps !== null && fix.speedMps >= opts.minHeadingSpeedMps && fix.headingDeg !== null && Number.isFinite(fix.headingDeg)
        ? fix.headingDeg
        : null
  return {
    state: {
      ...state,
      request: {
        id,
        purpose,
        sentAtMs: nowMs,
        alongM: tracking?.alongRouteM ?? 0,
        distanceFromRouteM: tracking?.distanceFromRouteM ?? 0,
      },
      nextRequestId: id + 1,
      requestsUsed: state.requestsUsed + 1,
      lastRequestAtMs: nowMs,
      recheck: false,
    },
    effects: [
      {
        type: 'request-routes',
        requestId: id,
        purpose,
        origin,
        headingDeg,
        // Room for this request and one more within the budget of ordinary checks.
        baseline: purpose === 'poll' && state.requestsUsed + 2 <= opts.maxRequests,
        probes: {
          allowed:
            purpose === 'poll'
              ? checkProbeAllowance({ requestsUsed: state.requestsUsed + 1, probesUsed: state.probes.used }, opts.maxRequests, opts.probes)
              : 0,
          memory: state.probes,
          budget: resolveDriveProbeBudget(opts.probes),
        },
      },
    ],
  }
}

/** After anything that may make a check due: sends one when the poll rule says so. */
function maybePoll(step: LiveStep, nowMs: number, opts: LiveOptions): LiveStep {
  if (livePollGate(step.state, nowMs, opts) !== 'due') return step
  const sent = request(step.state, 'poll', nowMs, opts)
  return { state: sent.state, effects: [...step.effects, ...sent.effects] }
}

function arrive(state: LiveState, nowMs: number): LiveStep {
  const summary: LiveSummary = {
    tripSec: Math.max(0, (nowMs - (state.startedAtMs ?? nowMs)) / 1000),
    switches: state.switches,
    declined: state.declinedSwitches,
    requestsUsed: state.requestsUsed,
  }
  return {
    state: { ...state, status: 'arrived', summary, request: null, turn: null, switchBanner: null, undo: null, pausedNote: null },
    effects: [...STOP_EFFECTS, { type: 'speak', line: { text: arrivalLine(summary), priority: 'urgent' } }],
  }
}

/** A good fix while driving: where is the car now, and what follows from that. */
function drive(state: LiveState, fix: PositionFix, nowMs: number, opts: LiveOptions): LiveStep {
  const route = state.route!
  const tracking = trackFix(state.tracking, trackedRoute(route.geometry), fix, opts.tracking)
  if (tracking === null) return { state, effects: [] }
  let next: LiveState = { ...state, tracking, lastFix: tracking.fix, gpsNote: null }
  if (tracking.arrived) return arrive(next, nowMs)

  const effects: LiveEffect[] = []
  if (tracking.offRoute) {
    const firstWord = !next.offRouteNotified
    if (firstWord) {
      next = { ...next, offRouteNotified: true, switchBanner: null, undo: null }
      // Must be heard: the "New route" line that follows within a second or two would
      // otherwise take its place in the queue, and the driver would never hear why.
      effects.push({ type: 'speak', line: { text: SPOKEN.offRoute, priority: 'urgent', mustHear: true } })
    }
    // A new route at once, the first time, whatever was asked a moment ago. If the car is
    // still off after that (a car park, a road the map does not know), again only every
    // replanGapSec, and not while it stands still.
    const sinceRequestSec = next.lastRequestAtMs === null ? Infinity : (nowMs - next.lastRequestAtMs) / 1000
    const stoppedSince = tracking.stoppedSinceMs
    const parked = stoppedSince !== null && (nowMs - stoppedSince) / 1000 > opts.stationaryPauseSec
    const again = next.offRouteReplans > 0 && next.request === null && sinceRequestSec >= opts.replanGapSec && !parked
    const inBudget = next.requestsUsed < opts.maxRequests + opts.offRouteReserve
    if (inBudget && next.hiddenSinceMs === null && (next.offRouteReplans === 0 || again)) {
      if (next.request !== null) effects.push({ type: 'cancel-request' })
      const sent = request({ ...next, request: null, offRouteReplans: next.offRouteReplans + 1 }, 'replan', nowMs, opts)
      return { state: sent.state, effects: [...effects, ...sent.effects] }
    }
    return { state: next, effects }
  }
  if (tracking.offFixes === 0) {
    if (next.offRouteNotified || next.offRouteReplans > 0) next = { ...next, offRouteNotified: false, offRouteReplans: 0 }
    const due = dueAnnouncement(route.guidance, next.guidance, tracking.alongRouteM)
    if (due.cursor !== next.guidance) next = { ...next, guidance: due.cursor }
    if (due.say !== null) {
      effects.push({
        type: 'speak',
        line: { text: due.say.text, priority: 'turn', distanceToManeuverM: due.say.distanceToManeuverM },
      })
    }
  }
  return maybePoll({ state: next, effects }, nowMs, opts)
}

/** The drive begins on `route`, from `fix`. */
function begin(state: LiveState, route: RouteCandidate, candidates: readonly RouteCandidate[], fix: PositionFix, nowMs: number, opts: LiveOptions): LiveStep {
  const started: LiveState = {
    ...state,
    status: 'driving',
    picked: null,
    route,
    tracking: null,
    request: null,
    candidates,
    lastCheckedAtMs: nowMs,
    eta: { durationSec: route.durationSec, remainingM: route.distanceM },
    guidance: armGuidance(route.guidance, 0, true),
    lastDecision: null,
  }
  const step = drive(started, fix, nowMs, opts)
  return { state: step.state, effects: [{ type: 'follow-route', geometry: route.geometry }, ...step.effects] }
}

/**
 * The first good fix, with a route picked on the plan screen: the drive starts
 * on that route, with no request, when the fix is on its line (the tracker's
 * own test, within its offRouteM). Null when it is not: the car is somewhere
 * else, and a route is asked for from there as without a pick.
 */
function startOnPicked(state: LiveState, fix: PositionFix, nowMs: number, opts: LiveOptions): LiveStep | null {
  const picked = state.picked
  if (picked === null) return null
  const onIt = trackFix(null, trackedRoute(picked.geometry), fix, opts.tracking)
  if (onIt === null || onIt.offFixes > 0) return null
  return begin({ ...state, lastFix: fix, gpsNote: null }, picked, [picked], fix, nowMs, opts)
}

/** The first route has come back. */
function planned(state: LiveState, routes: readonly RouteCandidate[] | null, message: string | undefined, nowMs: number, opts: LiveOptions): LiveStep {
  const best = routes === null ? undefined : rankRoutes(routes)[0]?.route
  const fix = state.lastFix
  if (routes === null || best === undefined || fix === null) {
    return fail(state, `Could not find a route from here. ${message ?? 'Try again in a moment.'}`)
  }
  return begin(state, best, routes, fix, nowMs, opts)
}

/** A check, or a search for a new route, has come back. */
function checked(
  state: LiveState,
  routes: readonly RouteCandidate[] | null,
  message: string | undefined,
  baseline: readonly RouteCandidate[] | null | undefined,
  probes: number,
  probesCounted: number,
  nowMs: number,
  opts: LiveOptions,
): LiveStep {
  const sent = state.request!
  const route = state.route!
  const tracking = state.tracking!
  const nowSec = (nowMs - (state.startedAtMs ?? nowMs)) / 1000
  const rerouteOffRouteM = opts.reroute.offRouteM ?? DEFAULT_REROUTE_OPTIONS.offRouteM
  const decision = decideReroute(
    state.engine,
    {
      nowSec,
      route,
      positionAlongM: sent.alongM,
      speedMps: tracking.speedMps,
      candidates: routes,
      // The tracker's verdict, not one reading: only a search for a new route says "off",
      // and only while the car is still off the line when it is answered. Answered once
      // the car is back on, it goes through the usual rules like any check.
      offRouteM: sent.purpose === 'replan' && tracking.offFixes > 0 ? Math.max(sent.distanceFromRouteM, rerouteOffRouteM + 1) : 0,
      baseline,
      // The answer is used where the car is now, not where it was asked from (a slow answer, a probe).
      drivenSinceM: Math.max(0, tracking.alongRouteM - sent.alongM),
    },
    opts.reroute,
  )
  const reason = routes === null && message !== undefined ? `${decision.reason} (${message})` : decision.reason
  let next: LiveState = {
    ...state,
    request: null,
    engine: decision.nextState,
    probes: rememberCheckProbes(state.probes, probes, decision, routes, probesCounted),
    lastDecision: { action: decision.action, code: decision.code, reason, atMs: nowMs },
  }
  if (routes === null) return { state: next, effects: [] }

  next = { ...next, candidates: routes, lastCheckedAtMs: nowMs }
  const chosen = decision.action === 'switch' ? routes.find((c) => c.id === decision.toRouteId) : undefined
  if (chosen === undefined) {
    const current = decision.current
    const pending = decision.code === 'confirming' || decision.code === 'cooldown'
    return {
      state: {
        ...next,
        eta: current === null ? next.eta : { durationSec: current.durationSec, remainingM: current.distanceM },
        turn: decision.considered !== null && pending ? { at: decision.considered.turnAt, pending: true } : null,
      },
      effects: [],
    }
  }

  const offRoute = decision.code === 'off-route'
  // A second new route in one excursion (still off the first) is taken without another word.
  const quiet = offRoute && state.offRouteReplans > 1
  const saving = decision.considered?.savingSec ?? null
  const sideStreet = chosen.source === 'probe'
  const onNew = retrack(tracking, trackedRoute(chosen.geometry), opts.tracking)
  const made: LiveSwitch = { atMs: nowMs, code: decision.code, reason: decision.reason, savingSec: offRoute ? null : saving }
  next = {
    ...next,
    route: chosen,
    tracking: onNew,
    guidance: armGuidance(chosen.guidance, onNew.alongRouteM, false),
    eta: { durationSec: chosen.durationSec, remainingM: chosen.distanceM },
    turn: decision.considered === null ? null : { at: decision.considered.turnAt, pending: false },
    switches: quiet ? state.switches : [...state.switches, made],
    switchBanner: quiet ? null : {
      untilMs: nowMs + opts.switchBannerSec * 1000,
      text: offRoute
        ? 'New route from here'
        : saving !== null
          ? `Switched to a faster route${sideStreet ? ' via side streets' : ''}: saves ${spokenDuration(saving)}`
          : 'Switched routes: the road ahead looks closed',
      canKeep: !offRoute,
    },
    // Off the route there is no previous route to keep.
    undo: offRoute ? null : { route, alongM: tracking.alongRouteM, engine: state.engine, eta: state.eta },
  }
  const say: LiveEffect = {
    type: 'speak',
    line: { text: switchLine(decision.code, saving, decision.considered?.turnInM ?? null, chosen.durationSec, sideStreet), priority: 'urgent' },
  }
  return { state: next, effects: [{ type: 'follow-route', geometry: chosen.geometry }, ...(quiet ? [] : [say])] }
}

/**
 * One step of the live drive: the state after `event`, and what the shell
 * has to do about it. Never throws; an event that does not apply to the
 * present state changes nothing.
 *
 * - **start**: watch the position, hold the screen awake, and say a few words
 *   at once (the tap is what lets a phone browser speak later).
 * - **fix**: the first good one starts the drive on the route picked on the
 *   plan screen when it is on that route's line (a side-street route too:
 *   the plan's answer counts as the first, so the first check is a poll
 *   interval later); otherwise it asks for a route from there. While driving,
 *   each one moves the car (tracking.ts); arriving ends the drive; being off
 *   the route (the tracker's verdict, never one fix) says so and asks for a
 *   new route at once; a turn prompt that has become due is spoken; and a
 *   check is sent when the poll rule (livePollGate) says one is due.
 * - **routes**: the first answer starts the drive on the best-ranked route. A
 *   later one goes to the reroute engine with the place the request was sent
 *   from; a switch is applied, announced, and can be undone for a few
 *   seconds. A failed check changes nothing but the engine's counter. When
 *   the fresh routes did not include the route being driven, the shell has
 *   asked for that path itself (one more request, counted) and the answer
 *   comes along as `baseline`: the current route's like-for-like ETA.
 * - **keep-previous**: back to the route just left, and the engine is told
 *   not to offer the other one again for `noReturnSec`.
 * - **visibility**: a spell in the background is measured; on return the
 *   screen lock is taken again and routes are rechecked at once.
 */
export function liveStep(state: LiveState, event: LiveEvent, options: Partial<LiveOptions> = {}): LiveStep {
  const opts = resolve(options)
  const active = state.status === 'locating' || state.status === 'planning' || state.status === 'driving'
  switch (event.type) {
    case 'start': {
      if (active) return { state, effects: [] }
      return {
        state: {
          ...LIVE_IDLE,
          status: 'locating',
          destination: event.destination,
          startedAtMs: event.nowMs,
          picked: drivable(event.route) ? event.route : null,
          muted: state.muted,
        },
        effects: [
          { type: 'set-muted', muted: state.muted },
          { type: 'prime-speech', text: SPOKEN.started },
          { type: 'watch-position' },
          { type: 'acquire-wake-lock' },
        ],
      }
    }
    case 'end': {
      if (state.status === 'idle') return { state, effects: [] }
      return { state: { ...LIVE_IDLE, muted: state.muted }, effects: [...STOP_EFFECTS, { type: 'stop-speaking' }] }
    }
    case 'mute':
      return { state: { ...state, muted: event.muted }, effects: [{ type: 'set-muted', muted: event.muted }] }
    case 'wake-lock': {
      // A lock the system took away ('released': the page went into the background) is asked for again on return.
      return { state: { ...state, wakeLock: event.result }, effects: [] }
    }
    case 'position-error': {
      if (!active) return { state, effects: [] }
      const message = POSITION_ERROR_MESSAGES[event.kind]
      if (FATAL.has(event.kind)) return fail(state, message)
      return { state: { ...state, gpsNote: message }, effects: [] }
    }
    case 'fix': {
      if (!active) return { state, effects: [] }
      if (!isUsableFix(event.fix, opts.tracking)) {
        const limitM = opts.tracking.maxAccuracyM ?? DEFAULT_TRACKING_OPTIONS.maxAccuracyM
        const note = state.status === 'locating' ? `Waiting for a better position fix (within ${limitM} m).` : state.gpsNote
        const tracking = state.tracking === null ? null : { ...state.tracking, ignoredFixes: state.tracking.ignoredFixes + 1 }
        return { state: { ...state, gpsNote: note, tracking }, effects: [] }
      }
      if (state.status === 'locating') {
        const onPicked = startOnPicked(state, event.fix, event.nowMs, opts)
        if (onPicked !== null) return onPicked
        const located: LiveState = { ...state, status: 'planning', lastFix: event.fix, gpsNote: null }
        return request(located, 'plan', event.nowMs, opts)
      }
      if (state.status === 'planning') return { state: { ...state, lastFix: event.fix, gpsNote: null }, effects: [] }
      return drive(state, event.fix, event.nowMs, opts)
    }
    case 'routes': {
      if (state.request === null || state.request.id !== event.requestId) return { state, effects: [] }
      if (state.request.purpose === 'plan') return planned(state, event.routes, event.message, event.nowMs, opts)
      if (state.status !== 'driving' || state.route === null || state.tracking === null) return { state: { ...state, request: null }, effects: [] }
      // More requests made for this answer (the current path's own travel time, side-street probes) count
      // too: those the shell reported as it sent them already are, the rest are counted now.
      const sentExtra = state.request.extraSent ?? 0
      const sentProbes = state.request.probesSent ?? 0
      const extra = Math.max(0, Math.round((event.requests ?? 1) - 1) - sentExtra)
      const counted = extra === 0 ? state : { ...state, requestsUsed: state.requestsUsed + extra }
      const probes = Math.max(0, Math.round(event.probes ?? 0))
      return checked(counted, event.routes, event.message, event.baseline, probes, sentProbes, event.nowMs, opts)
    }
    case 'request-sent': {
      if (!active) return { state, effects: [] }
      const ours = state.request !== null && state.request.id === event.requestId
      return {
        state: {
          ...state,
          requestsUsed: state.requestsUsed + 1,
          probes: event.probe ? { ...state.probes, used: state.probes.used + 1 } : state.probes,
          request:
            ours && state.request !== null
              ? {
                  ...state.request,
                  extraSent: (state.request.extraSent ?? 0) + 1,
                  probesSent: (state.request.probesSent ?? 0) + (event.probe ? 1 : 0),
                }
              : state.request,
        },
        effects: [],
      }
    }
    case 'keep-previous': {
      const { undo, route, tracking, switchBanner } = state
      if (state.status !== 'driving' || undo === null || route === null || tracking === null || switchBanner === null) return { state, effects: [] }
      const nowSec = (event.nowMs - (state.startedAtMs ?? event.nowMs)) / 1000
      const noReturnSec = opts.reroute.noReturnSec ?? DEFAULT_REROUTE_OPTIONS.noReturnSec
      const back = retrack(tracking, trackedRoute(undo.route.geometry), opts.tracking, undo.alongM)
      return {
        state: {
          ...state,
          route: undo.route,
          tracking: back,
          engine: declineRoute(undo.engine, lineFrom(route.geometry, tracking.alongRouteM), nowSec + noReturnSec),
          // The engine's confirmation is dropped, and with it the probe being confirmed.
          probes: { ...state.probes, keep: null },
          guidance: armGuidance(undo.route.guidance, back.alongRouteM, false),
          eta: undo.eta,
          turn: null,
          // The check that is out is cancelled below; its answer will never come.
          request: null,
          switchBanner: null,
          undo: null,
          switches: state.switches.slice(0, -1),
          declinedSwitches: state.declinedSwitches + 1,
          lastDecision: { action: 'stay', code: 'kept-previous', reason: 'Staying: you chose to keep the previous route', atMs: event.nowMs },
        },
        effects: [
          // A check that is out was asked about the route just left behind.
          ...(state.request === null ? [] : ([{ type: 'cancel-request' }] as const)),
          { type: 'follow-route', geometry: undo.route.geometry },
          { type: 'speak', line: { text: SPOKEN.keptPrevious, priority: 'urgent' } },
        ],
      }
    }
    case 'visibility': {
      if (!active) return { state, effects: [] }
      if (event.hidden) return { state: state.hiddenSinceMs === null ? { ...state, hiddenSinceMs: event.nowMs } : state, effects: [] }
      if (state.hiddenSinceMs === null) return { state, effects: [{ type: 'acquire-wake-lock' }] }
      const seconds = Math.round((event.nowMs - state.hiddenSinceMs) / 1000)
      const long = seconds >= opts.hiddenNoteMinSec
      const back: LiveState = {
        ...state,
        hiddenSinceMs: null,
        pausedNote: long ? { seconds, untilMs: event.nowMs + opts.pausedNoteSec * 1000 } : state.pausedNote,
        recheck: state.recheck || (long && state.status === 'driving'),
      }
      return maybePoll({ state: back, effects: [{ type: 'acquire-wake-lock' }] }, event.nowMs, opts)
    }
    case 'tick': {
      if (!active) return { state, effects: [] }
      let next = state
      if (next.switchBanner !== null && event.nowMs >= next.switchBanner.untilMs) next = { ...next, switchBanner: null, undo: null }
      if (next.pausedNote !== null && event.nowMs >= next.pausedNote.untilMs) next = { ...next, pausedNote: null }
      return maybePoll({ state: next, effects: [] }, event.nowMs, opts)
    }
  }
}

/** What the drive view shows, worked out from the state and the time. */
export interface LiveView {
  readonly status: LiveStatus
  readonly nextTurn: NextTurn | null
  readonly remainingM: number | null
  /** Time left, scaled from the last travel time heard for this route by the distance left. */
  readonly remainingSec: number | null
  /** When the car gets there, on the clock `nowMs` is from. */
  readonly arrivalAtMs: number | null
  /** The quiet line: the engine's latest reason, or what the drive is waiting for. */
  readonly statusLine: string
  /** Seconds since the last answered check. Null before the first. */
  readonly checkedAgoSec: number | null
  readonly checking: boolean
  readonly offRoute: boolean
  /** One-line warnings, most pressing first. */
  readonly warnings: readonly string[]
  readonly requestsUsed: number
  readonly maxRequests: number
}

export const WAKE_LOCK_WARNING = 'This browser cannot keep the screen awake. Keep the screen on yourself.'

export function liveView(state: LiveState, nowMs: number, options: Partial<LiveOptions> = {}): LiveView {
  const opts = resolve(options)
  const { tracking, route, eta } = state
  const remainingM = tracking?.remainingM ?? null
  const remainingSec =
    remainingM === null || eta === null ? null : eta.remainingM > 0 ? eta.durationSec * Math.min(1, remainingM / eta.remainingM) : 0
  const gate = livePollGate(state, nowMs, opts)
  const offRoute = tracking?.offRoute ?? false

  let statusLine: string
  if (state.status === 'locating') statusLine = 'Finding your position…'
  else if (state.status === 'planning') statusLine = 'Finding a route…'
  else if (state.status === 'failed') statusLine = state.message ?? 'The drive could not go on.'
  else if (state.status === 'arrived') statusLine = 'Arrived'
  else if (offRoute) statusLine = 'Off the route. Finding a new one…'
  else if (gate === 'budget-spent') statusLine = `Request budget used up (${opts.maxRequests}): driving on without checking for faster routes.`
  else if (gate === 'stationary') statusLine = 'Standing still: checks are paused until you move.'
  else if (gate === 'no-fix') statusLine = 'Waiting for a position fix…'
  else statusLine = state.lastDecision?.reason ?? 'Watching for a faster route.'

  const warnings: string[] = []
  if (state.pausedNote !== null) warnings.push(`RouteIQ was paused for ${state.pausedNote.seconds} s while in the background.`)
  if (state.gpsNote !== null && state.status !== 'failed') warnings.push(state.gpsNote)
  if (state.wakeLock === 'unavailable') warnings.push(WAKE_LOCK_WARNING)

  return {
    status: state.status,
    nextTurn: route === null || tracking === null || offRoute ? null : nextTurn(route.guidance, tracking.alongRouteM),
    remainingM,
    remainingSec,
    arrivalAtMs: remainingSec === null ? null : nowMs + remainingSec * 1000,
    statusLine,
    checkedAgoSec: state.lastCheckedAtMs === null ? null : Math.max(0, Math.round((nowMs - state.lastCheckedAtMs) / 1000)),
    checking: state.request !== null,
    offRoute,
    warnings,
    requestsUsed: state.requestsUsed,
    maxRequests: opts.maxRequests,
  }
}
