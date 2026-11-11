/**
 * What is said when: the rules for a voice that must never fall behind the
 * drive. Pure: the queue is plain data, the speech engine is somewhere else
 * (src/device/speech.ts) and only does what these functions answer.
 *
 * At most two lines exist at any time: the one being spoken and one waiting.
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
 */
export function enqueueSpeech(queue: SpeechQueue, line: SpokenLine): { readonly queue: SpeechQueue; readonly action: SpeechAction } {
  if (line.text.trim() === '') return { queue, action: 'drop' }
  const { speaking, waiting } = queue
  if (speaking === null) return { queue: { speaking: line, waiting }, action: 'speak' }
  const nearTurn = speaking.priority === 'turn' && (speaking.distanceToManeuverM ?? Infinity) <= NEAR_TURN_M
  if (line.priority === 'urgent' && speaking.priority !== 'urgent' && !nearTurn) {
    return { queue: { speaking: line, waiting }, action: 'interrupt' }
  }
  if (waiting === null || RANK[line.priority] >= RANK[waiting.priority]) {
    return { queue: { speaking, waiting: line }, action: 'wait' }
  }
  return { queue, action: 'drop' }
}

/** The line being spoken has ended (or failed): the waiting one, if any, is next. */
export function speechFinished(queue: SpeechQueue): { readonly queue: SpeechQueue; readonly next: SpokenLine | null } {
  return { queue: { speaking: queue.waiting, waiting: null }, next: queue.waiting }
}
