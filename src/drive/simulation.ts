import { findCurrentRoute, type RouteCandidate } from '../core/index.ts'

/**
 * The pure parts of the simulated drive (PLAN step 6): the simulated clock,
 * when a poll is due, the budget of real Directions requests, and the
 * "what-if" delay. No React, no timers, no network: useDriveSim.ts runs these
 * on a real timer. The switching rules themselves are in src/core/reroute.ts;
 * nothing here decides a route.
 */

/** How many simulated seconds pass per real second. */
export const SPEED_MULTIPLIERS = [1, 5, 20] as const
export type SpeedMultiplier = (typeof SPEED_MULTIPLIERS)[number]

export interface DriveSettings {
  /** A poll is due every this many seconds of SIMULATED time. */
  readonly pollIntervalSec: number
  /** The most Directions requests one simulated drive may make. After that it drives on without polling. */
  readonly maxRequests: number
}

export const DEFAULT_DRIVE_SETTINGS: DriveSettings = { pollIntervalSec: 60, maxRequests: 60 }

/**
 * At most one Directions request per this many REAL milliseconds, whatever
 * the speed multiplier. Not a setting: it is what keeps a 20x drive from
 * sending a request every three seconds.
 */
export const MIN_REQUEST_GAP_MS = 5000

/** Polling faster than this in simulated time is refused, so the settings box cannot be used to hammer the API. */
export const MIN_POLL_INTERVAL_SEC = 10

/** Where a simulated drive stands. Plain numbers; replaced, never edited. */
export interface DriveClock {
  /** Seconds of simulated time since the drive started. This is the engine's clock. */
  readonly simTimeSec: number
  /** Meters driven along the current route (from its start; a switch starts a new route at 0). */
  readonly alongM: number
  /** The simulated time of the last poll (0 at the start: the routes on screen are fresh then). */
  readonly lastPollSimSec: number
  /** The real time of the last Directions request, in milliseconds. Null before the first. */
  readonly lastRequestRealMs: number | null
  /** Directions requests made so far on this drive. */
  readonly requestsUsed: number
}

export const DRIVE_START: DriveClock = {
  simTimeSec: 0,
  alongM: 0,
  lastPollSimSec: 0,
  lastRequestRealMs: null,
  requestsUsed: 0,
}

/**
 * Moves the drive on by `realDtMs` of real time: simulated time runs
 * `multiplier` times as fast, and the car covers speed x simulated time,
 * stopping at the end of the route. A step that is negative or not a number
 * moves nothing; a long one (a sleeping tab) is cut to one second.
 */
export function advance(
  clock: DriveClock,
  realDtMs: number,
  multiplier: number,
  speedMps: number,
  routeLengthM: number,
): DriveClock {
  if (!Number.isFinite(realDtMs) || realDtMs <= 0) return clock
  const simDtSec = (Math.min(realDtMs, 1000) / 1000) * Math.max(0, multiplier)
  const alongM = Math.min(routeLengthM, clock.alongM + Math.max(0, speedMps) * simDtSec)
  return { ...clock, simTimeSec: clock.simTimeSec + simDtSec, alongM }
}

/** Whether a poll may be sent now, and if not, what it is waiting for. */
export type PollGate = 'due' | 'not-yet' | 'request-gap' | 'budget-spent'

/**
 * A poll is due once `pollIntervalSec` of simulated time has passed since
 * the last one, but never while the request budget is spent and never
 * within MIN_REQUEST_GAP_MS of real time of the last request.
 */
export function pollGate(clock: DriveClock, realNowMs: number, settings: DriveSettings): PollGate {
  const interval = Math.max(MIN_POLL_INTERVAL_SEC, settings.pollIntervalSec)
  if (!(clock.simTimeSec - clock.lastPollSimSec >= interval)) return 'not-yet'
  if (!(clock.requestsUsed < settings.maxRequests)) return 'budget-spent'
  if (clock.lastRequestRealMs !== null && realNowMs - clock.lastRequestRealMs < MIN_REQUEST_GAP_MS) return 'request-gap'
  return 'due'
}

/** The clock after a request has been sent now. */
export function afterRequest(clock: DriveClock, realNowMs: number): DriveClock {
  return {
    ...clock,
    lastPollSimSec: clock.simTimeSec,
    lastRequestRealMs: realNowMs,
    requestsUsed: clock.requestsUsed + 1,
  }
}

/** The clock after a switch: the new route is driven from its start. */
export function afterSwitch(clock: DriveClock): DriveClock {
  return { ...clock, alongM: 0 }
}

/**
 * The speed the simulated car drives a route at: the route's own average
 * (length over traffic-aware time), so the drive takes about as long as the
 * ETA says. Kept between walking pace and 45 m/s (100 mph) against odd data.
 */
export function cruiseSpeedMps(route: Pick<RouteCandidate, 'distanceM' | 'durationSec'>): number {
  const speed = route.distanceM / route.durationSec
  return Number.isFinite(speed) ? Math.min(45, Math.max(1.5, speed)) : 13
}

/**
 * The "what-if" injector: makes the route being driven look `delaySec`
 * slower in a poll's answer, so a switch can be watched without waiting for
 * real traffic. SIMULATED data: the delay exists nowhere but in the returned
 * copies. The candidate that is the rest of the current route (the engine's
 * own matching, findCurrentRoute) gets the delay; everything else, and the
 * input, is left as it is. No delay, or no matching candidate, changes nothing.
 */
export function withWhatIfDelay(
  candidates: readonly RouteCandidate[],
  route: Pick<RouteCandidate, 'geometry'>,
  alongM: number,
  delaySec: number,
): readonly RouteCandidate[] {
  if (!Number.isFinite(delaySec) || delaySec <= 0) return candidates
  const current = findCurrentRoute(route, alongM, candidates)
  if (current === null) return candidates
  return candidates.map((c) => (c === current ? { ...c, durationSec: c.durationSec + delaySec } : c))
}

/** One line of the drive's event log. */
export interface DriveLogEntry {
  readonly id: number
  /** Simulated time of the event, in seconds since the drive started. */
  readonly simTimeSec: number
  /** 'stay' and 'switch' are engine decisions; 'note' is the simulator talking (start, arrival, budget). */
  readonly kind: 'stay' | 'switch' | 'note'
  readonly text: string
  /** True when a what-if delay was part of the data behind this line. */
  readonly simulated: boolean
}

/** Simulated time as a stopwatch: "0:00", "12:05", "1:02:03". */
export function formatSimClock(sec: number): string {
  const total = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
