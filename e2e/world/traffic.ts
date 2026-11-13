// Traffic scripts for the made-up road network: who is slow, where, and from when.
// `n` counts the scenario's Directions requests: 1 is the trip planned on the
// first screen, 2 and on the drive's checks for faster routes, about one a
// minute from the first minute (the drive starts on the route picked on the
// plan screen, with no request of its own: #66). A side-street probe (a
// request with one via point beside a route, on the plan screen or during a
// drive) does not count: it is answered with the traffic of the plan or the
// check it belongs to. The drive's check of its own path (also with vias)
// does count.

import { FREE_FLOW, type Closure, type Traffic } from './roads.ts'

/** A jam on the middle of the direct route (A) from the second check of the drive on. Route B goes round it. */
export const JAM_ON_A_FROM_SECOND_CHECK: Traffic = (route, at, n) => {
  const onJammedStretch = Math.abs(at.side - 300) < 50 && at.f > 0.42 && at.f < 0.75
  return FREE_FLOW(route, at, n) * (n >= 3 && onJammedStretch ? 4 : 1)
}

/**
 * Every route a little faster or slower from one check to the next (up to 6 %),
 * so now and then an alternative looks a little quicker than the route being
 * driven, but never by enough to be worth a change. Deterministic: the same
 * request number always gives the same traffic.
 */
export const NOISY_BUT_NOTHING_FASTER: Traffic = (route, at, n) => {
  // The trip is planned in free flow, so A is clearly the one to take.
  if (n <= 1) return FREE_FLOW(route, at, n)
  const phase = route === 'A' ? 0 : route === 'B' ? 2.1 : 4.2
  return FREE_FLOW(route, at, n) * (1 + 0.06 * Math.sin(n * 1.7 + phase))
}

/**
 * A jam on Main Corridor just after it jogs east (from a quarter to 40 % of the
 * trip), the stretch A, B and C all share: Mapbox's three routes all sit in it,
 * and A stays the fastest of them. Parallel Street (S) keeps straight on there
 * and misses the jam, so the side street is the fastest way through.
 */
export const JAM_WHERE_ALL_THREE_SHARE: Traffic = (route, at, n) => {
  const jammed = Math.abs(at.side - 300) < 50 && at.f > 0.25 && at.f < 0.4
  return FREE_FLOW(route, at, n) * (jammed ? 2 : 1)
}

/**
 * The jam of JAM_WHERE_ALL_THREE_SHARE (Main Corridor just after it jogs east,
 * where A, B and C all run), only from request `fromRequest` on and `factor`
 * times the usual pace. From 2: the trip is planned in free flow (A is
 * recommended, Parallel Street last), and the jam builds by the drive's first
 * check. Parallel Street misses it; what it then saves depends on `factor`
 * (about 4 minutes at 3x, about a minute at 2x).
 */
export function jamWhereAllThreeShare(factor: number, fromRequest = 2): Traffic {
  return (route, at, n) => {
    const jammed = n >= fromRequest && Math.abs(at.side - 300) < 50 && at.f > 0.25 && at.f < 0.4
    return FREE_FLOW(route, at, n) * (jammed ? factor : 1)
  }
}

/**
 * A block of Main Corridor closed from the drive's second check (request 3) on:
 * the middle of its own stretch (60 to 70 % of the trip), where neither East
 * Loop nor West Loop runs. From then on Mapbox no longer offers A, and asked
 * for A itself (the drive's check of its own path) it answers NoRoute. Traffic
 * stays free flowing, so no other route is faster by time alone: in free flow
 * A is the fastest, and only the closure makes the drive leave it.
 */
export const BLOCK_OF_A_CLOSED_FROM_SECOND_CHECK: Closure = (at, n) =>
  n >= 3 && Math.abs(at.side - 300) < 50 && at.f > 0.6 && at.f < 0.7

/**
 * A jam on the direct route (A) from the second check of the drive on, only where the East Loop
 * (B) goes round it and the West Loop (C) does not: from 42 % to 56 % of the trip, before C
 * swings west at 55 %. So the East Loop is the one faster route, and turning it down leaves none.
 */
export const JAM_ONLY_THE_EAST_LOOP_MISSES: Traffic = (route, at, n) => {
  const onJammedStretch = Math.abs(at.side - 300) < 50 && at.f > 0.42 && at.f < 0.56
  return FREE_FLOW(route, at, n) * (n >= 3 && onJammedStretch ? 5 : 1)
}

/**
 * Every road, side streets included, 1.6 times its usual pace from request `fromRequest` on, all
 * the way to the end: the route being driven is well over its typical time at every check (so the
 * checks keep probing), and nothing is faster than staying, Parallel Street least of all.
 */
export function everyRoadSlow(factor = 1.6, fromRequest = 2): Traffic {
  return (route, at, n) => FREE_FLOW(route, at, n) * (n >= fromRequest ? factor : 1)
}

/**
 * The jam of JAM_ONLY_THE_EAST_LOOP_MISSES (only the East Loop goes round it), but only from
 * request 7 on, the drive's sixth check (about six minutes in). At 24 m/s that check is the
 * first to see the East Loop win, with its turn-off about a mile ahead; by the next check, a
 * minute on, the turn-off is too close to take safely. So the faster route is offered once and
 * never confirmed by the checks alone: the evening drive of #197.
 */
export const JAM_ONLY_THE_EAST_LOOP_MISSES_LATE: Traffic = (route, at, n) => {
  const onJammedStretch = Math.abs(at.side - 300) < 50 && at.f > 0.42 && at.f < 0.56
  return FREE_FLOW(route, at, n) * (n >= 7 && onJammedStretch ? 5 : 1)
}

/** The speed at which JAM_ONLY_THE_EAST_LOOP_MISSES_LATE's offer is seen once and then too late, m/s. */
export const LATE_OFFER_SPEED_MPS = 24
