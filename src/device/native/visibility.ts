import type { PageVisibility } from '../visibility.ts'

/**
 * In a browser a hidden page gets no GPS, so the live session stops asking
 * for routes until it is back (core/live.ts, 'visibility'). In the shell the
 * position, the voice and the clock are native and go on with the phone
 * locked, so being hidden is not a reason to pause: the session is never
 * told the page was hidden.
 */
export const ALWAYS_IN_FRONT: PageVisibility = {
  isHidden: () => false,
  subscribe: () => () => {},
}
