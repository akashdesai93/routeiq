import type { RouteCandidate } from './types.ts'

/**
 * How much slower (positive) or faster (negative) the route is right now than
 * its typical time, in seconds. Null when the provider gave no typical
 * duration: the difference is never guessed.
 */
export function delayVsTypicalSec(
  route: Pick<RouteCandidate, 'durationSec' | 'typicalDurationSec'>,
): number | null {
  const { durationSec, typicalDurationSec } = route
  if (typicalDurationSec === null) return null
  if (!Number.isFinite(durationSec) || !Number.isFinite(typicalDurationSec)) return null
  return durationSec - typicalDurationSec
}
