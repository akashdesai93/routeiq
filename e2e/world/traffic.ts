// Traffic scripts for the made-up road network: who is slow, where, and from when.
// `n` counts the scenario's Directions requests: 1 is the trip planned on the
// first screen, 2 the first route of the drive, 3 and on the checks for faster
// routes, about one a minute.

import { FREE_FLOW, type Traffic } from './roads.ts'

/** A jam on the middle of the direct route (A) from the second check of the drive on. Route B goes round it. */
export const JAM_ON_A_FROM_SECOND_CHECK: Traffic = (route, at, n) => {
  const onJammedStretch = Math.abs(at.side - 300) < 50 && at.f > 0.42 && at.f < 0.75
  return FREE_FLOW(route, at, n) * (n >= 4 && onJammedStretch ? 4 : 1)
}

/**
 * Every route a little faster or slower from one check to the next (up to 6 %),
 * so now and then an alternative looks a little quicker than the route being
 * driven, but never by enough to be worth a change. Deterministic: the same
 * request number always gives the same traffic.
 */
export const NOISY_BUT_NOTHING_FASTER: Traffic = (route, at, n) => {
  // The trip is planned and the drive starts in free flow, so A is clearly the one to take.
  if (n <= 2) return FREE_FLOW(route, at, n)
  const phase = route === 'A' ? 0 : route === 'B' ? 2.1 : 4.2
  return FREE_FLOW(route, at, n) * (1 + 0.06 * Math.sin(n * 1.7 + phase))
}
