import { spokenDistance } from './reroute.ts'
import type { GuidanceAnnouncement, GuidanceStep, LngLat } from './types.ts'

/**
 * Turn guidance for a live drive: what to show ("next turn: arrow, distance,
 * road") and what to say, given how far along the route the car is. Pure:
 * the route's guidance (RouteCandidate.guidance, filled by the directions
 * adapter) and the meters driven come in, plain data comes out.
 */

/** The picture of a maneuver: which arrow to draw. */
export type ArrowKind =
  | 'straight'
  | 'slight-left'
  | 'left'
  | 'sharp-left'
  | 'slight-right'
  | 'right'
  | 'sharp-right'
  | 'uturn'
  | 'merge'
  | 'roundabout'
  | 'depart'
  | 'arrive'

const BY_MODIFIER: Readonly<Record<string, ArrowKind>> = {
  straight: 'straight',
  'slight left': 'slight-left',
  left: 'left',
  'sharp left': 'sharp-left',
  'slight right': 'slight-right',
  right: 'right',
  'sharp right': 'sharp-right',
  uturn: 'uturn',
}

/** The arrow for a maneuver type and modifier as the Directions API names them. Anything unknown is "straight". */
export function arrowKind(type: string, modifier: string | null): ArrowKind {
  if (type === 'arrive') return 'arrive'
  if (type === 'depart') return 'depart'
  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') return 'roundabout'
  const byModifier = modifier === null ? undefined : BY_MODIFIER[modifier]
  if (type === 'merge' && (byModifier === undefined || byModifier === 'straight')) return 'merge'
  return byModifier ?? 'straight'
}

/** A maneuver this many meters behind the car is still "the next one": the car is in the middle of it. */
export const MANEUVER_PASSED_M = 15

/** What the drive view shows about the maneuver ahead. */
export interface NextTurn {
  readonly arrow: ArrowKind
  /** Meters from the car to the maneuver. Never below 0. */
  readonly distanceM: number
  readonly primaryText: string
  readonly secondaryText: string | null
  readonly type: string
  readonly modifier: string | null
  readonly location: LngLat
}

/**
 * The maneuver to show: the first one still ahead of the car (or within
 * MANEUVER_PASSED_M behind it), setting off left aside. Null when the route
 * has no guidance or nothing is left of it.
 */
export function nextTurn(guidance: readonly GuidanceStep[] | undefined, alongM: number): NextTurn | null {
  const step = (guidance ?? []).find((g) => g.type !== 'depart' && g.atDistanceM >= alongM - MANEUVER_PASSED_M)
  if (step === undefined) return null
  return {
    arrow: arrowKind(step.type, step.modifier),
    distanceM: Math.max(0, step.atDistanceM - alongM),
    primaryText: step.primaryText,
    secondaryText: step.secondaryText,
    type: step.type,
    modifier: step.modifier,
    location: step.location,
  }
}

/** One announcement of a route, with the maneuver it is about. */
interface Flat {
  readonly atDistanceM: number
  readonly text: string
  readonly maneuverAtM: number
}

const flattened = new WeakMap<readonly GuidanceStep[], readonly Flat[]>()

/** Every announcement of a route in the order it becomes due. Worked out once per guidance list. */
function flat(guidance: readonly GuidanceStep[]): readonly Flat[] {
  const known = flattened.get(guidance)
  if (known !== undefined) return known
  const all = guidance
    .flatMap((g) => g.announcements.map((a) => ({ atDistanceM: a.atDistanceM, text: a.text, maneuverAtM: g.atDistanceM })))
    .filter((a) => Number.isFinite(a.atDistanceM) && a.text !== '')
    // Stable: announcements due at the same place keep the order of their maneuvers.
    .sort((a, b) => a.atDistanceM - b.atDistanceM)
  flattened.set(guidance, all)
  return all
}

/**
 * Which announcements of a route have been dealt with: all those before
 * `next` in the order they become due. Plain data, kept by the caller for
 * one route; a new route gets a new cursor (armGuidance).
 */
export interface GuidanceCursor {
  readonly next: number
}

/**
 * The cursor to start a route with, for a car `alongM` meters along it.
 * Announcements already behind the car are never spoken. `speakDue` says
 * what to do with those due exactly where the car starts (the route's
 * opening line, "Drive north on ..."): true at the start of a drive, so it
 * is spoken; false after a switch, where the switch announcement has just
 * said what comes next.
 */
export function armGuidance(guidance: readonly GuidanceStep[] | undefined, alongM: number, speakDue: boolean): GuidanceCursor {
  const all = flat(guidance ?? [])
  if (speakDue) {
    // Keep the newest of the lines due here; dueAnnouncement drops the older ones itself.
    return { next: 0 }
  }
  let next = 0
  while (next < all.length && all[next]!.atDistanceM <= alongM) next++
  return { next }
}

/** Something that is due to be said now. */
export interface DueAnnouncement {
  readonly text: string
  /** Meters from the car to the maneuver it is about. */
  readonly distanceToManeuverM: number
}

/**
 * The announcement that is due for a car `alongM` meters along the route,
 * and the cursor to pass next time. Each announcement is due once: when the
 * car first reaches the place it is set for. When several have become due
 * since the last call (a gap in the fixes, a jump), only the newest whose
 * maneuver is still ahead is said; the rest are dropped, not queued up.
 */
export function dueAnnouncement(
  guidance: readonly GuidanceStep[] | undefined,
  cursor: GuidanceCursor,
  alongM: number,
): { readonly say: DueAnnouncement | null; readonly cursor: GuidanceCursor } {
  const all = flat(guidance ?? [])
  let next = Math.max(0, cursor.next)
  let due: Flat | null = null
  while (next < all.length && all[next]!.atDistanceM <= alongM) {
    const a = all[next]!
    if (a.maneuverAtM >= alongM - MANEUVER_PASSED_M) due = a
    next++
  }
  if (next === cursor.next) return { say: null, cursor }
  return {
    say: due === null ? null : { text: due.text, distanceToManeuverM: Math.max(0, due.maneuverAtM - alongM) },
    cursor: { next },
  }
}

/**
 * After a new route that the spoken line gave no turn for, the next maneuver is
 * announced at once (nextManeuverLine), unless it, or its next announcement
 * still ahead of the car, is within this many meters: then that comes in a
 * moment anyway (or the maneuver is already under way).
 */
export const NEXT_TURN_SOON_M = 300

/**
 * What to say about the way ahead right after the route changed under the car
 * (#183): a new route found off the route, or one taken because the road ahead
 * closed, whose spoken line ("New route. 28 minutes to your destination.")
 * names no turn. The cursor after a switch skips every announcement due where
 * the car is (the route's opening line among them), so on a long stretch the
 * driver would hear nothing until half a mile before the next turn, which on
 * a freeway can be many minutes away.
 *
 * The line is the next maneuver's own last announcement (the instruction
 * itself: "Turn left onto Cross Street."), with the distance to it in front:
 * "In 2.1 miles, turn left onto Cross Street." Null when that maneuver is
 * within `soonM` of the car (or behind it), when its next announcement still
 * ahead is due within `soonM` (it is said in a moment), when its last line is
 * not a bare instruction (it already names a distance, or opens with "Then,"),
 * when it
 * is the arrival (the new-route line has just said how far that is), or when
 * nothing is left.
 */
export function nextManeuverLine(
  guidance: readonly GuidanceStep[] | undefined,
  alongM: number,
  soonM: number = NEXT_TURN_SOON_M,
): DueAnnouncement | null {
  if (!Number.isFinite(alongM)) return null
  const step = (guidance ?? []).find((g) => g.type !== 'depart' && g.atDistanceM >= alongM - MANEUVER_PASSED_M)
  if (step === undefined || step.type === 'arrive') return null
  const lines = step.announcements.filter((a) => Number.isFinite(a.atDistanceM) && a.text.trim() !== '')
  const last = lines.at(-1)?.text.trim()
  // Only the bare instruction takes a distance in front: a line with one of its own ("In a
  // quarter mile, ...") or an opening line ("Drive north on A Road. Then, ...") would read twice.
  if (last === undefined || /^In\b/.test(last) || /\bThen,/.test(last)) return null
  // A maneuver this near (or just behind) is said by its own prompt, or is already done.
  const distanceToManeuverM = step.atDistanceM - alongM
  if (!(distanceToManeuverM > soonM)) return null
  // Its next line still ahead of the car is near: that comes in a moment.
  const ahead = lines.map((a) => a.atDistanceM).filter((m) => m > alongM)
  if (ahead.length > 0 && Math.min(...ahead) - alongM <= soonM) return null
  return { text: `In ${spokenDistance(distanceToManeuverM)}, ${lowerFirst(last)}`, distanceToManeuverM }
}

/** How far before a maneuver the first made-up announcement comes, at most, in meters (half a mile). */
export const SYNTH_FAR_M = 800
/** How far before a maneuver the last made-up announcement comes, in meters. */
export const SYNTH_NEAR_M = 90

function lowerFirst(text: string): string {
  // "Turn left onto ..." reads on after "In 0.4 miles, "; a road name at the start ("I-77 ...") is left alone.
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text
}

/**
 * Simple announcements for a maneuver the provider sent no voice
 * instructions for, made from its plain instruction ("Turn left onto Main
 * Street."): one well ahead ("In 0.4 miles, turn left onto Main Street."),
 * when the stretch leading to it is long enough, and the instruction itself
 * shortly before. `approachFromM` is where the stretch leading to the
 * maneuver begins; nothing is set before it.
 */
export function synthesizeAnnouncements(instruction: string, approachFromM: number, atDistanceM: number): GuidanceAnnouncement[] {
  const text = instruction.trim()
  if (text === '' || !Number.isFinite(atDistanceM)) return []
  const fromM = Math.max(0, Number.isFinite(approachFromM) ? Math.min(approachFromM, atDistanceM) : 0)
  const leadM = atDistanceM - fromM
  const out: GuidanceAnnouncement[] = []
  if (leadM >= SYNTH_NEAR_M * 3) {
    const farM = Math.min(leadM, SYNTH_FAR_M)
    out.push({ atDistanceM: atDistanceM - farM, text: `In ${spokenDistance(farM)}, ${lowerFirst(text)}` })
  }
  out.push({ atDistanceM: Math.max(fromM, atDistanceM - SYNTH_NEAR_M), text })
  return out
}
