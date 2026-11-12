import { alongRouteM, isValidLngLat, nearestAlongM, pointAtDistance, type LngLat, type PositionFix } from '../core/index.ts'
import type { PositionSource } from '../device/geolocation.ts'

/**
 * GPS replay (development only): a made-up driver whose position fixes go
 * through the SAME code path as the device's GPS. It follows whatever route
 * the live session is driving (the session tells it: PositionSource.follow),
 * so it is the simulated drive as a second position source, with the
 * things real GPS does to a tracker: noise, dropouts, a stop at a light, a
 * tunnel, and a wrong turn. SIMULATED data: no position here is anyone's.
 *
 * The driver (replayStep) is pure and runs on a fake clock in the tests;
 * createReplaySource runs it on a timer for the browser.
 */

export interface ReplayPlan {
  /** Cruising speed, in meters per second. */
  readonly speedMps: number
  /** Standard deviation of the position noise, in meters. 0 for none. */
  readonly noiseM: number
  /** Seed of the noise, so a replay is the same every time. */
  readonly seed: number
  /** The accuracy each fix reports, in meters. */
  readonly accuracyM: number
  /** Whether fixes carry the device's own speed and heading (some devices give neither). */
  readonly deviceMotion: boolean
  /** Stretches of drive time, [fromSec, toSec], in which no fix is delivered. */
  readonly dropoutsSec: readonly (readonly [number, number])[]
  /** A stop: on reaching `atM` meters driven, the car stands for `forSec`. Null for none. */
  readonly stop: { readonly atM: number; readonly forSec: number } | null
  /** A tunnel: no fixes between `fromM` and `toM` meters driven. Null for none. */
  readonly tunnel: { readonly fromM: number; readonly toM: number } | null
  /**
   * A wrong turn: from `atM` meters driven the car drifts `offsetM` to the
   * side of the route and stays there until the session gives it a new
   * route, or for `maxSec` at most; then it is back on the route it is
   * given. Null for none.
   */
  readonly excursion: { readonly atM: number; readonly offsetM: number; readonly maxSec: number } | null
}

export const DEFAULT_REPLAY_PLAN: ReplayPlan = {
  speedMps: 15,
  noiseM: 5,
  seed: 1,
  accuracyM: 8,
  deviceMotion: true,
  dropoutsSec: [],
  stop: null,
  tunnel: null,
  excursion: null,
}

/** The made-up driver between two steps. Plain data. */
export interface ReplayState {
  /** Seconds of drive time so far. */
  readonly timeSec: number
  /** The route being followed. Null before the session has one: the car waits at its start. */
  readonly route: readonly LngLat[] | null
  /** Meters along that route. */
  readonly alongM: number
  /** Meters driven in all, across route changes: what the plan's distances are measured in. */
  readonly drivenM: number
  /** Where the car truly is (noise comes on top). */
  readonly position: LngLat
  readonly headingDeg: number
  readonly speedMps: number
  /** Seconds still to stand at the stop; null before it is reached, 0 once it is over. */
  readonly stopLeftSec: number | null
  /** The wrong turn: not yet, under way (since when), or over. */
  readonly excursion: 'ahead' | { readonly sinceSec: number } | 'done'
  readonly rng: number
  /** True at the end of the route. */
  readonly finished: boolean
}

export function replayStart(origin: LngLat, plan: ReplayPlan): ReplayState {
  return {
    timeSec: 0,
    route: null,
    alongM: 0,
    drivenM: 0,
    position: origin,
    headingDeg: 0,
    speedMps: 0,
    stopLeftSec: null,
    excursion: 'ahead',
    rng: plan.seed >>> 0 || 1,
    finished: false,
  }
}

/** mulberry32: a small seeded generator. Returns the next seed and a number from 0 to 1. */
function random(seed: number): [number, number] {
  const next = (seed + 0x6d2b79f5) >>> 0
  let t = next
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return [next, ((t ^ (t >>> 14)) >>> 0) / 4294967296]
}

const M_PER_DEGREE = 111_195

/** The point `eastM` east and `northM` north of `p`. */
function offset(p: LngLat, eastM: number, northM: number): LngLat {
  return [p[0] + eastM / (M_PER_DEGREE * Math.cos((p[1] * Math.PI) / 180)), p[1] + northM / M_PER_DEGREE]
}

/**
 * The driver is given a route to follow (the session's first route, or the
 * one it switched to): it carries on from the point of that route nearest
 * to where it is. A wrong turn under way is over: the new route is the way
 * back.
 */
export function replayFollow(state: ReplayState, geometry: readonly LngLat[]): ReplayState {
  const route = geometry.filter(isValidLngLat)
  if (route.length < 2) return state
  return {
    ...state,
    route,
    alongM: nearestAlongM(route, state.position),
    excursion: state.excursion === 'ahead' ? 'ahead' : 'done',
    finished: false,
  }
}

/**
 * Moves the driver on by `dtSec` of drive time and answers the fix a
 * device would report then, stamped `timeMs`; null when the plan says no
 * fix comes through (a dropout, the tunnel). Before the session has given
 * it a route the car stands at its origin and reports that.
 */
export function replayStep(state: ReplayState, dtSec: number, timeMs: number, plan: ReplayPlan): { state: ReplayState; fix: PositionFix | null } {
  const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0
  let { alongM, drivenM, stopLeftSec, excursion, position, headingDeg, finished } = state
  const timeSec = state.timeSec + dt
  let speedMps = 0
  const route = state.route

  if (route !== null && !finished) {
    if (plan.stop !== null && stopLeftSec === null && drivenM >= plan.stop.atM) stopLeftSec = plan.stop.forSec
    if (stopLeftSec !== null && stopLeftSec > 0) {
      stopLeftSec = Math.max(0, stopLeftSec - dt)
    } else {
      speedMps = Math.max(0, plan.speedMps)
      const lengthM = alongRouteM(route).at(-1) ?? 0
      const stepM = Math.min(speedMps * dt, lengthM - alongM)
      alongM += stepM
      drivenM += stepM
      finished = alongM >= lengthM
    }
    if (plan.excursion !== null) {
      if (excursion === 'ahead' && drivenM >= plan.excursion.atM) excursion = { sinceSec: timeSec }
      else if (typeof excursion === 'object' && timeSec - excursion.sinceSec >= plan.excursion.maxSec) excursion = 'done'
    }
    const on = pointAtDistance(route, alongM)!
    headingDeg = on.bearingDeg
    position = on.point
    if (typeof excursion === 'object' && plan.excursion !== null) {
      // Drifts out over ten seconds, to the right of the direction of travel.
      const share = Math.min(1, (timeSec - excursion.sinceSec) / 10)
      const side = ((headingDeg + 90) * Math.PI) / 180
      position = offset(position, Math.sin(side) * plan.excursion.offsetM * share, Math.cos(side) * plan.excursion.offsetM * share)
    }
  }

  // Two uniform numbers make one pair of normal ones (Box-Muller).
  const [seedA, u] = random(state.rng)
  const [rng, v] = random(seedA)
  const radius = plan.noiseM > 0 ? plan.noiseM * Math.sqrt(-2 * Math.log(Math.max(u, 1e-12))) : 0
  const reported = offset(position, radius * Math.cos(2 * Math.PI * v), radius * Math.sin(2 * Math.PI * v))

  const next: ReplayState = { timeSec, route, alongM, drivenM, position, headingDeg, speedMps, stopLeftSec, excursion, rng, finished }
  const silent =
    plan.dropoutsSec.some(([from, to]) => timeSec >= from && timeSec < to) ||
    (plan.tunnel !== null && drivenM >= plan.tunnel.fromM && drivenM < plan.tunnel.toM)
  if (silent) return { state: next, fix: null }
  return {
    state: next,
    fix: {
      lng: reported[0],
      lat: reported[1],
      accuracyM: plan.accuracyM,
      speedMps: plan.deviceMotion ? speedMps : null,
      // A device standing still reports no heading.
      headingDeg: plan.deviceMotion && speedMps > 0 ? headingDeg : null,
      timeMs,
    },
  }
}

/** How many times faster than real time a replay may run. */
export const REPLAY_MULTIPLIERS = [1, 5, 20] as const
export type ReplayMultiplier = (typeof REPLAY_MULTIPLIERS)[number]

/** A fix is made every this many seconds of drive time, as a phone does. */
export const REPLAY_FIX_INTERVAL_SEC = 1

export interface ReplaySourceOptions {
  /** Where the made-up car starts: stands in for the device's position. */
  readonly origin: LngLat
  readonly plan: ReplayPlan
  readonly multiplier: () => number
  /** Real time, in milliseconds. */
  readonly realNow?: () => number
  /** Calls `fn` every `ms` real milliseconds; returns the function that stops it. */
  readonly every?: (ms: number, fn: () => void) => () => void
}

/**
 * The replay as a position source with a clock of its own. Drive time runs
 * `multiplier` times as fast as real time, and `now()` is the clock the
 * whole live session runs on during a replay, so its rules (a check every
 * 60 s, eight seconds of patience) hold in drive time. `hold(true)` stops
 * the clock while a route request is out, as the simulated drive does, so
 * the answer is for the place the car is at.
 */
export interface ReplaySource extends PositionSource {
  now(): number
  hold(held: boolean): void
  /** The true (noise-free) state of the made-up driver, for the tests. */
  peek(): ReplayState
}

const REPLAY_TICK_MS = 200

export function createReplaySource(options: ReplaySourceOptions): ReplaySource {
  const {
    origin,
    plan,
    multiplier,
    realNow = () => performance.now(),
    every = (ms, fn) => {
      const id = setInterval(fn, ms)
      return () => clearInterval(id)
    },
  } = options
  // Drive time starts at the wall clock's time, so arrival times read like real ones.
  const startMs = Date.now()
  let driveMs = 0
  let owedSec = 0
  let held = false
  let state = replayStart(origin, plan)
  return {
    now: () => startMs + driveMs,
    hold(next) {
      held = next
    },
    peek: () => state,
    follow(geometry) {
      state = replayFollow(state, geometry)
    },
    start(onFix) {
      let last = realNow()
      // The first fix at once, like a device that already knows where it is.
      const first = replayStep(state, 0, startMs + driveMs, plan)
      state = first.state
      if (first.fix !== null) onFix(first.fix)
      return every(REPLAY_TICK_MS, () => {
        const now = realNow()
        // A sleeping tab does not make the car leap.
        const realDtMs = Math.min(1000, Math.max(0, now - last))
        last = now
        if (held) return
        owedSec += (realDtMs / 1000) * Math.max(0, multiplier())
        while (owedSec >= REPLAY_FIX_INTERVAL_SEC && !held) {
          owedSec -= REPLAY_FIX_INTERVAL_SEC
          driveMs += REPLAY_FIX_INTERVAL_SEC * 1000
          const step = replayStep(state, REPLAY_FIX_INTERVAL_SEC, startMs + driveMs, plan)
          state = step.state
          // Handing over a fix can start a request, which holds the clock: the loop then stops.
          if (step.fix !== null) onFix(step.fix)
        }
      })
    },
  }
}

