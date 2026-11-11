/**
 * What is said when: the rules for a voice that must never fall behind the
 * drive. Pure: the queue is plain data, the speech engine is somewhere else
 * (src/device/speech.ts) and only does what these functions answer.
 *
 * At most two lines exist at any time: the one being spoken and one waiting.
 * A line the driver must hear (`mustHear`) is never lost from the waiting
 * place: what comes after it is said after it, as part of the same line.
 */

/**
 * How much a line matters:
 * - 'urgent': a change of route, off the route, arrival.
 * - 'turn': a turn prompt.
 * - 'info': anything that can be lost ("RouteIQ started").
 */
export type SpeechPriority = 'urgent' | 'turn' | 'info'

/** One thing to say. */
export interface SpokenLine {
  readonly text: string
  readonly priority: SpeechPriority
  /** For a turn prompt: meters from the car to the maneuver when the line was made. */
  readonly distanceToManeuverM?: number
  /**
   * True for a line that explains what happens next and so must not be
   * replaced before it has been said ("You are off the route. Finding a new
   * one."): without it the driver hears a new route announced and never why.
   */
  readonly mustHear?: boolean
  /** Set by the queue on a line it has joined to a follow-up: the must-hear words at its start. */
  readonly mustHearText?: string
}

export interface SpeechQueue {
  readonly speaking: SpokenLine | null
  readonly waiting: SpokenLine | null
}

export const EMPTY_SPEECH_QUEUE: SpeechQueue = { speaking: null, waiting: null }

/** A turn prompt for a maneuver this close is not interrupted: the driver needs it now. In meters. */
export const NEAR_TURN_M = 200

const RANK: Readonly<Record<SpeechPriority, number>> = { info: 1, turn: 2, urgent: 3 }

/**
 * What the speech engine is to do with a new line:
 * - 'speak': nothing is being said; say it now.
 * - 'interrupt': stop what is being said and say this instead.
 * - 'wait': it is next, after the line being spoken.
 * - 'drop': it is not said at all.
 */
export type SpeechAction = 'speak' | 'interrupt' | 'wait' | 'drop'

/**
 * Adds a line. The rules:
 * - Nothing being said: it is said at once.
 * - An urgent line cuts off whatever is being said, unless that is urgent
 *   itself or a turn prompt for a maneuver within NEAR_TURN_M.
 * - Otherwise it waits. Only one line waits: against one already waiting,
 *   the more important stays, and of two equals the newer (it is the
 *   fresher information). So nothing ever piles up behind the voice.
 * - A waiting line that must be heard (`mustHear`) is not replaced. A line
 *   that would have replaced it is said straight after it instead: the two
 *   become one waiting line, the must-hear words first ("You are off the
 *   route. Finding a new one. New route. 12 minutes to your destination.").
 *   Only the latest follow-up is kept, so it is still one line waiting, and
 *   a less important line is dropped as before.
 */
export function enqueueSpeech(queue: SpeechQueue, line: SpokenLine): { readonly queue: SpeechQueue; readonly action: SpeechAction } {
  if (line.text.trim() === '') return { queue, action: 'drop' }
  const { speaking, waiting } = queue
  if (speaking === null) return { queue: { speaking: line, waiting }, action: 'speak' }
  const nearTurn = speaking.priority === 'turn' && (speaking.distanceToManeuverM ?? Infinity) <= NEAR_TURN_M
  if (line.priority === 'urgent' && speaking.priority !== 'urgent' && !nearTurn) {
    return { queue: { speaking: line, waiting }, action: 'interrupt' }
  }
  if (waiting === null) return { queue: { speaking, waiting: line }, action: 'wait' }
  if (RANK[line.priority] < RANK[waiting.priority]) return { queue, action: 'drop' }
  if (waiting.mustHear === true && line.mustHear !== true) {
    // `mustHearText` is the part that has to stay; a newer follow-up takes the place of an older one.
    const first = waiting.mustHearText ?? waiting.text
    return {
      queue: { speaking, waiting: { text: `${first} ${line.text}`, priority: line.priority, mustHear: true, mustHearText: first } },
      action: 'wait',
    }
  }
  return { queue: { speaking, waiting: line }, action: 'wait' }
}

/** The line being spoken has ended (or failed): the waiting one, if any, is next. */
export function speechFinished(queue: SpeechQueue): { readonly queue: SpeechQueue; readonly next: SpokenLine | null } {
  return { queue: { speaking: queue.waiting, waiting: null }, next: queue.waiting }
}
