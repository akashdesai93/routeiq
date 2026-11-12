import {
  alongRouteM,
  DEFAULT_TRACKING_OPTIONS,
  distanceM,
  isValidLngLat,
  lineFrom,
  localProjector,
  pointAtDistance,
  pointToSegment,
  type LngLat,
} from '../core/index.ts'

/**
 * The iPhone app's "Test drive": a made-up car that drives the selected
 * route, so a drive can be tried at home with the phone locked. The car is
 * moved by the app's native code (the plugin's startSimulatedRoute), about
 * one position a second, which iOS keeps running while the phone is locked;
 * this file only writes the script it follows. SIMULATED data: no position
 * here is anyone's.
 *
 * Pure: the same input always gives the same script. The browser's
 * development replay (replay.ts) is a different thing and is not touched.
 */

export type TestDrivePreset = 'follow' | 'wrong-turn' | 'turn-around'

export const TEST_DRIVE_PRESETS: readonly { readonly id: TestDrivePreset; readonly label: string; readonly hint: string }[] = [
  { id: 'follow', label: 'Follow the route', hint: 'The car drives the route to the end.' },
  {
    id: 'wrong-turn',
    label: 'Wrong turn after 1 min',
    hint: 'After a minute the car turns off onto a side street and keeps going. Listen for "You are off the route" and then "New route"; the car then follows the new route.',
  },
  {
    id: 'turn-around',
    label: 'Turn around after 1 min',
    hint: 'After a minute the car makes a U-turn and drives back the way it came, then stops.',
  },
]

/** How many times faster than a real car the made-up one may drive. The clock stays real. */
export const TEST_DRIVE_MULTIPLIERS = [1, 3] as const
export type TestDriveMultiplier = (typeof TEST_DRIVE_MULTIPLIERS)[number]

/** What the shell's "Test drive" control is set to. Kept by App for the page's lifetime. */
export interface TestDriveSetup {
  /** True: "Start drive" follows the made-up car in place of the phone's GPS. */
  readonly enabled: boolean
  readonly preset: TestDrivePreset
  readonly multiplier: TestDriveMultiplier
}

export const DEFAULT_TEST_DRIVE_SETUP: TestDriveSetup = { enabled: false, preset: 'wrong-turn', multiplier: 1 }

/** Every number of the test drive, in one place. */
export interface TestDriveOptions {
  /** Cruising speed at 1x, in meters per second (15 is about 34 mph). */
  readonly speedMps: number
  /** The wrong turn or U-turn comes after this many meters driven at 1x speed for a minute. */
  readonly eventAfterM: number
  /** ...but no later than this share of the route that is left, so a short route has one too. */
  readonly eventLatestShare: number
  /** A route shorter than this, in meters, is only followed: there is no room for an event. */
  readonly minRouteForEventM: number
  /** The side street of the wrong turn (and the way back after a U-turn) is at least this long, in meters... */
  readonly excursionMinM: number
  /** ...and at least this many seconds of driving, so the tracker has time to call it. */
  readonly excursionMinSec: number
  /** Speed through the turn at 1x, in meters per second. */
  readonly turnSpeedMps: number
  /** The car slows this many meters before the turn and is back at speed this many after. */
  readonly turnSlowM: number
  /** The car stands this long in the middle of a U-turn, in seconds. */
  readonly uTurnStopSec: number
}

export const DEFAULT_TEST_DRIVE_OPTIONS: TestDriveOptions = {
  speedMps: 15,
  eventAfterM: 900,
  eventLatestShare: 0.5,
  minRouteForEventM: 300,
  excursionMinM: 600,
  excursionMinSec: 45,
  turnSpeedMps: 5,
  turnSlowM: 30,
  uTurnStopSec: 3,
}

/**
 * One step of the script the native code follows: on reaching `atM` meters
 * along the points, the speed becomes `speedMps` (when given) and the car
 * stands for `stopSec` (when given).
 */
export interface SimulatedStep {
  readonly atM: number
  readonly speedMps?: number
  readonly stopSec?: number
}

/** What the plugin's startSimulatedRoute takes: the line to drive, how fast, and the script. */
export interface SimulatedRoute {
  readonly points: LngLat[]
  /** Meters per second. 0: the car stands at the first point. */
  readonly speedMps: number
  readonly script: SimulatedStep[]
}

export interface TestDriveScript extends SimulatedRoute {
  /** Meters along `points` at which the wrong turn or U-turn begins. Null when this script has none. */
  readonly eventAtM: number | null
}

export interface TestDriveInput {
  /** The route the live session is driving. */
  readonly geometry: readonly LngLat[]
  /** Where the made-up car is. Null: at the start of the route. */
  readonly from: LngLat | null
  /** Meters the car has driven so far in this drive, over every route. */
  readonly drivenM: number
  /** True once the wrong turn or U-turn has begun: from then on the car follows whatever route it is given. */
  readonly eventBegun: boolean
  readonly preset: TestDrivePreset
  readonly multiplier: number
}

const M_PER_DEGREE = 111_195

/** The point `meters` from `p` in the direction `bearing` (degrees clockwise from north). */
function pointToward(p: LngLat, bearing: number, meters: number): LngLat {
  const rad = (bearing * Math.PI) / 180
  return [p[0] + (Math.sin(rad) * meters) / (M_PER_DEGREE * Math.cos((p[1] * Math.PI) / 180)), p[1] + (Math.cos(rad) * meters) / M_PER_DEGREE]
}

/** The closest point of `line` to `p`: how far away it is, and how many meters along the line. */
export function nearestOnLine(line: readonly LngLat[], p: LngLat): { distanceM: number; alongM: number } {
  const first = line[0]
  if (first === undefined) return { distanceM: Infinity, alongM: 0 }
  const project = localProjector(p)
  const along = alongRouteM(line)
  let best = { distanceM: distanceM(p, first), alongM: 0 }
  for (let i = 1; i < line.length; i++) {
    const hit = pointToSegment([0, 0], project(line[i - 1]!), project(line[i]!))
    if (hit.distanceM < best.distanceM) best = { distanceM: hit.distanceM, alongM: along[i - 1]! + hit.t * (along[i]! - along[i - 1]!) }
  }
  return best
}

/** The first `untilM` meters of a line: its vertices up to there, then the point there. */
function lineUntil(line: readonly LngLat[], untilM: number): LngLat[] {
  const end = pointAtDistance(line, untilM)
  if (end === null) return []
  const along = alongRouteM(line)
  const head = line.filter((_, i) => along[i]! < untilM)
  const last = head.at(-1)
  return last !== undefined && last[0] === end.point[0] && last[1] === end.point[1] ? head : [...head, end.point]
}

/** How far the side street from `turn` in direction `bearing` stays from the route, once it is 100 m out. */
function clearanceM(route: readonly LngLat[], turn: LngLat, bearing: number, lengthM: number): number {
  let least = Infinity
  for (let m = 100; m <= lengthM; m += 100) least = Math.min(least, nearestOnLine(route, pointToward(turn, bearing, m)).distanceM)
  return least
}

const whole = (value: number, least: number) => (Number.isFinite(value) && value >= least ? value : least)

/**
 * The script for the made-up car, from where it is now.
 *
 * - **Follow the route**: the rest of the route, from the point of it nearest
 *   the car, at cruising speed.
 * - **Wrong turn**: the same until `eventAfterM` meters have been driven; there
 *   the car slows, turns square off the route (to the side that stays farther
 *   from it) and drives straight on along a made-up side street, long enough
 *   for the tracker to call it off the route. When the session answers with a
 *   new route, the car follows that (`eventBegun`).
 * - **Turn around**: at the same point the car slows, stops, and drives back
 *   over the road it came on, then stands.
 *
 * At the end of the points the car stands still; it keeps reporting where it is.
 */
export function buildTestDrive(input: TestDriveInput, options: TestDriveOptions = DEFAULT_TEST_DRIVE_OPTIONS): TestDriveScript {
  const route = input.geometry.filter(isValidLngLat)
  const from = input.from !== null && isValidLngLat(input.from) ? input.from : null
  const multiplier = whole(input.multiplier, 1)
  const cruise = options.speedMps * multiplier
  if (route.length < 2) return { points: from !== null ? [from] : route.slice(0, 1), speedMps: 0, script: [], eventAtM: null }

  // The car carries on from the point of the route nearest to it, driving there first when it is elsewhere.
  const rest = from === null ? [...route] : lineFrom(route, nearestOnLine(route, from).alongM)
  const joinM = from === null ? 0 : distanceM(from, rest[0]!)
  const lead: LngLat[] = from !== null && joinM > 1 ? [from] : []
  const leadM = lead.length > 0 ? joinM : 0
  const restM = alongRouteM(rest).at(-1) ?? 0
  const plain: TestDriveScript = { points: [...lead, ...rest], speedMps: cruise, script: [], eventAtM: null }
  if (input.preset === 'follow' || input.eventBegun || restM < options.minRouteForEventM) return plain

  const driven = whole(input.drivenM, 0)
  const turnAlongM = Math.min(Math.max(0, options.eventAfterM - driven - leadM), restM * options.eventLatestShare)
  const turn = pointAtDistance(rest, turnAlongM)
  if (turn === null) return plain
  const before = [...lead, ...lineUntil(rest, turnAlongM)]
  const eventAtM = leadM + turnAlongM
  const excursionM = Math.max(options.excursionMinM, cruise * options.excursionMinSec)
  const slowAtM = Math.max(0, eventAtM - options.turnSlowM)
  const turnSpeed = options.turnSpeedMps * multiplier

  if (input.preset === 'wrong-turn') {
    const right = (turn.bearingDeg + 90) % 360
    const left = (turn.bearingDeg + 270) % 360
    // To the right, unless the route itself goes that way and the left stays clear of it.
    const rightClear = clearanceM(route, turn.point, right, excursionM)
    const side = rightClear > DEFAULT_TRACKING_OPTIONS.offRouteM * 2 || rightClear >= clearanceM(route, turn.point, left, excursionM) ? right : left
    return {
      points: [...before, pointToward(turn.point, side, excursionM)],
      speedMps: cruise,
      script: [
        { atM: slowAtM, speedMps: turnSpeed },
        { atM: eventAtM + options.turnSlowM, speedMps: cruise },
      ],
      eventAtM,
    }
  }

  // Turn around: back over the points just driven, newest first.
  const back = lineUntil([...before].reverse(), excursionM).slice(1)
  if (back.length === 0) return plain
  return {
    points: [...before, ...back],
    speedMps: cruise,
    script: [
      { atM: slowAtM, speedMps: turnSpeed },
      { atM: eventAtM, stopSec: options.uTurnStopSec },
      { atM: eventAtM + options.turnSlowM, speedMps: cruise },
    ],
    eventAtM,
  }
}
