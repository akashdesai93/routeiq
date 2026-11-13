import { distanceM } from './geo.ts'
import { MANEUVER_PASSED_M } from './guidance.ts'
import { DEFAULT_LIVE_OPTIONS, type LiveOptions, type LiveState } from './live.ts'
import type { GuidanceStep } from './types.ts'

/**
 * The life of a switch offer, for the drive diagnostics (#202): each offer the driver was
 * shown, then exactly one of how it ended. Worked out from two live states, the one before
 * a step and the one after it, so it needs nothing the state machine does not already keep.
 *
 * Privacy: what comes out is a few words from fixed lists and whole seconds; never where the
 * offer turned off or what its streets were called.
 */

/** How an offer ended: the driver took it or kept their route, the app confirmed it, a check withdrew it, or it ran out. */
export type OfferEnding = 'taken' | 'kept' | 'confirmed' | 'withdrawn' | 'expired'

/**
 * Why it was withdrawn or ran out. 'not-faster' and 'unconfirmed' (a check compared and found
 * it not worth a switch, or could not compare) withdraw it; 'replaced' (the next check offered
 * a route that turns off somewhere else) too. 'too-late' (its turn-off came nearer than the
 * lead), 'off-route' and 'drive-ended' make it expire.
 */
export type OfferEndReason = 'not-faster' | 'unconfirmed' | 'replaced' | 'too-late' | 'off-route' | 'drive-ended'

/**
 * After a switch to an offered route: whether the directions ahead changed. 'changed': the
 * maneuvers still to come differ from the route left's; 'unchanged': they are the very same
 * (the driver is told nothing new); 'none': the new route has no turn-by-turn directions ahead.
 */
export type OfferDirections = 'changed' | 'unchanged' | 'none'

export type OfferLifeEvent =
  | {
      readonly kind: 'shown'
      /** The check outcome that put it on screen: 'confirming', 'cooldown', or another code. */
      readonly why: string
      /** What it saves, whole seconds; null when unknown (never guessed). */
      readonly savingSec: number | null
    }
  | {
      readonly kind: 'ended'
      readonly how: OfferEnding
      /** Set for 'withdrawn' and 'expired', null otherwise (and for a withdrawal the state does not explain: never guessed). */
      readonly reason: OfferEndReason | null
      /** Whole seconds since it was shown. */
      readonly afterSec: number
      /** Set for 'taken' and 'confirmed', null otherwise. */
      readonly directions: OfferDirections | null
    }

/** What is remembered between steps: when the offer on screen was shown. */
export interface OfferLifeMemory {
  readonly shownAtMs: number | null
}

export const INITIAL_OFFER_LIFE: OfferLifeMemory = { shownAtMs: null }

/** The maneuvers still ahead on a route (as nextTurn sees them), setting off left aside. */
function stepsAhead(state: LiveState): readonly GuidanceStep[] {
  if (state.route === null || state.tracking === null) return []
  const along = state.tracking.alongRouteM
  return (state.route.guidance ?? []).filter((g) => g.type !== 'depart' && g.atDistanceM >= along - MANEUVER_PASSED_M)
}

/**
 * Whether the directions ahead changed from `before` to `after` (a switch): some maneuver
 * still to come is another one, or somewhere else, or there are more or fewer of them. The
 * routes part at the turn-off, so a real switch always changes them, however far ahead it is.
 */
function directionsAfterSwitch(before: LiveState, after: LiveState, matchM: number): OfferDirections {
  const now = stepsAhead(after)
  if (now.length === 0) return 'none'
  const was = stepsAhead(before)
  const same =
    was.length === now.length &&
    was.every((w, i) => w.type === now[i].type && w.modifier === now[i].modifier && distanceM(w.location, now[i].location) <= matchM)
  return same ? 'unchanged' : 'changed'
}

/** True when `after` holds a decision that `before` did not, with this code. */
const decided = (before: LiveState, after: LiveState, code: string) =>
  after.lastDecision !== null && after.lastDecision.code === code && after.lastDecision !== before.lastDecision

/**
 * What happened to the offer between two states, oldest first: an ending, a new offer, or
 * both (one offer gave way to another). `nowMs`: the time of the step.
 */
export function offerLife(
  memory: OfferLifeMemory,
  before: LiveState,
  after: LiveState,
  nowMs: number,
  options: Partial<LiveOptions> = {},
): { readonly memory: OfferLifeMemory; readonly events: readonly OfferLifeEvent[] } {
  const matchM = options.heldTurnMatchM ?? DEFAULT_LIVE_OPTIONS.heldTurnMatchM
  const was = before.offer
  const now = after.offer
  // The same offer renewed by a check: it turns off at the same place.
  const replaced =
    was !== null && now !== null && before.turn !== null && after.turn !== null && distanceM(before.turn.at, after.turn.at) > matchM
  if (was === now || (was !== null && now !== null && !replaced)) return { memory, events: [] }

  const events: OfferLifeEvent[] = []
  if (was !== null) {
    const afterSec = Math.max(0, Math.round((nowMs - (memory.shownAtMs ?? nowMs)) / 1000))
    const end = (how: OfferEnding, reason: OfferEndReason | null = null, directions: OfferDirections | null = null) =>
      events.push({ kind: 'ended', how, reason, afterSec, directions })
    const switched = after.switches.length > before.switches.length
    if (replaced) end('withdrawn', 'replaced')
    else if (decided(before, after, 'taken-offer')) end('taken', null, directionsAfterSwitch(before, after, matchM))
    else if (decided(before, after, 'kept-previous')) end('kept')
    else if (switched && after.switches.at(-1)!.code === 'faster-route') end('confirmed', null, directionsAfterSwitch(before, after, matchM))
    else if (after.status !== 'driving') end('expired', 'drive-ended')
    else if (after.tracking?.offRoute === true || after.offRouteNotified) end('expired', 'off-route')
    else if (after.withdrawn !== null && after.withdrawn !== before.withdrawn) {
      const reason = after.withdrawn.reason
      if (reason === 'too-late') end('expired', 'too-late')
      else end('withdrawn', reason)
    } else end('withdrawn')
  }
  if (now !== null) {
    const why = after.lastDecision?.code ?? 'other'
    const saving = now.savingSec
    events.push({ kind: 'shown', why, savingSec: saving === null || !Number.isFinite(saving) ? null : Math.max(0, Math.round(saving)) })
  }
  return { memory: { shownAtMs: now === null ? null : nowMs }, events }
}
