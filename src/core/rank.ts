import { formatDuration } from './format.ts'
import type { RankedRoute, RouteCandidate } from './types.ts'

/**
 * Two routes whose traffic-aware ETAs are this close are a tie: the gap is
 * inside the noise of a live traffic estimate and nobody would feel it. Only
 * inside this window does the signal count get a say. The one place the
 * default is set; override it per call with RankOptions.etaTieWindowSec.
 */
export const DEFAULT_ETA_TIE_WINDOW_SEC = 30

export interface RankOptions {
  /** See DEFAULT_ETA_TIE_WINDOW_SEC. Negative or not a number is treated as 0 (exact ties only). */
  readonly etaTieWindowSec?: number
}

function compare<T extends number | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A duration that is not a real number sorts last. */
function eta(route: RouteCandidate): number {
  return Number.isFinite(route.durationSec) ? route.durationSec : Infinity
}

/** The fallback order everywhere: ETA, then distance, then id, so the result never depends on input order. */
function byEta(a: RouteCandidate, b: RouteCandidate): number {
  return compare(eta(a), eta(b)) || compare(a.distanceM, b.distanceM) || compare(a.id, b.id)
}

/**
 * The signal count, when it is the whole answer. A count with partial
 * coverage is a lower bound, not a number to compare, so it is unknown here.
 */
function knownSignals(route: RouteCandidate): number | null {
  const n = route.signalCount
  return route.signalCoverage === 'full' && n !== null && Number.isFinite(n) ? n : null
}

/** "3 fewer signals", "1 more signal". */
function signalGap(n: number, word: 'fewer' | 'more'): string {
  return `${n} ${word} ${n === 1 ? 'signal' : 'signals'}`
}

/**
 * Orders routes from most to least recommended and says why, in plain words.
 *
 * The rule: **best traffic-aware ETA first; the signal count only breaks ties.**
 *
 * 1. The fastest route is the one with the lowest `durationSec`.
 * 2. Every route within `etaTieWindowSec` of the fastest (the edge included:
 *    exactly 30 s is a tie, 31 s is not) is tied with it. The window is
 *    measured from the fastest route only and never chained: a route within
 *    the window of a tied route, but not of the fastest, is not tied.
 * 3. Among the tied routes, fewer signals wins. Routes with the same count
 *    fall back to ETA, then distance, then id.
 * 4. A tied route whose signal count is unknown (null, or its signalCoverage
 *    is not 'full': a partial count is only a lower bound) carries no
 *    information, so it never wins or loses on signals: it keeps the place its ETA (then
 *    distance, then id) gives it among the tied routes, and only the routes
 *    with known counts are reordered, among the places they hold between
 *    them. So the recommended route is always either the fastest one or one
 *    with fewer known signals than the fastest. When no count is known this
 *    is plain ETA order.
 * 5. Routes outside the window follow, by ETA, then distance, then id.
 *
 * There is deliberately NO per-signal time penalty. A traffic-aware ETA
 * already contains the typical delay at every signal on the route, so adding
 * seconds per signal would count that delay twice. Signals only decide
 * between routes the ETA cannot tell apart.
 *
 * Pure and deterministic: the same routes in any order give the same ranking.
 * Ranks run 1, 2, 3 with no gaps or shared ranks. An empty list gives an
 * empty list.
 */
export function rankRoutes(routes: readonly RouteCandidate[], options: RankOptions = {}): RankedRoute[] {
  const requested = options.etaTieWindowSec ?? DEFAULT_ETA_TIE_WINDOW_SEC
  const windowSec = Number.isFinite(requested) && requested > 0 ? requested : 0

  const sorted = [...routes].sort(byEta)
  const fastest = sorted[0]
  if (fastest === undefined) return []
  const bestSec = eta(fastest)
  const isTied = (r: RouteCandidate) => eta(r) === bestSec || eta(r) - bestSec <= windowSec

  const tied = sorted.filter(isTied)
  const known = tied
    .filter((r) => knownSignals(r) !== null)
    .sort((a, b) => compare(knownSignals(a)!, knownSignals(b)!) || byEta(a, b))
  const ordered = tied.map((r) => (knownSignals(r) === null ? r : known.shift()!))
  ordered.push(...sorted.filter((r) => !isTied(r)))

  const top = ordered[0]!
  const sharedBest = sorted.filter((r) => eta(r) === bestSec).length > 1

  const reason = (route: RouteCandidate): string => {
    if (ordered.length === 1) return 'Only route found'
    if (eta(route) === Infinity) return 'No travel time available'
    const behindSec = eta(route) - bestSec
    if (!isTied(route)) {
      const whole = Math.ceil(behindSec)
      return `${whole < 60 ? `${whole} s` : formatDuration(behindSec)} slower than the fastest`
    }
    const time =
      behindSec > 0
        ? `Within ${Math.round(windowSec)} s of the fastest`
        : sharedBest
          ? 'Tied for fastest'
          : 'Fastest right now'
    // What the signals had to do with it. The recommended route is compared
    // with the route it beat on signals (the fastest one, or the one sharing
    // its ETA); every other tied route is compared with the recommended one.
    const isTop = route === top
    const other = !isTop
      ? top
      : route !== fastest
        ? fastest
        : ordered.find((r) => r !== route && eta(r) === bestSec)
    const mine = knownSignals(route)
    const theirs = other === undefined ? null : knownSignals(other)
    if (mine === null || theirs === null) return time
    if (isTop) return mine < theirs ? `${time}, ${signalGap(theirs - mine, 'fewer')}` : time
    if (mine === theirs) return `${time}, same number of signals as the recommended route`
    return mine > theirs
      ? `${time}, ${signalGap(mine - theirs, 'more')} than the recommended route`
      : `${time}, ${signalGap(theirs - mine, 'fewer')} than the recommended route`
  }

  return ordered.map((route, i) => ({ route, rank: i + 1, reasons: [reason(route)] }))
}

/** The id of the top-ranked route: the default selection. Null when there are no routes. */
export function recommendedRouteId(
  routes: readonly RouteCandidate[],
  options: RankOptions = {},
): string | null {
  return rankRoutes(routes, options)[0]?.route.id ?? null
}

const MINUS = '−'
const M_PER_MILE = 1609.344

/** "−8", "+2", "0": a whole number with its sign, the minus a real minus sign. */
function signed(n: number): string {
  return n < 0 ? `${MINUS}${-n}` : n > 0 ? `+${n}` : '0'
}

/**
 * The delta row of the route list (design #21/#44: "−8 min · −2 lights ·
 * −3 mi"): what the recommended route gives against another, each as a signed
 * figure and its unit. Minutes and miles are rounded (miles to a whole one
 * from 10 up, to a tenth below). Lights are compared only when both counts
 * are full; otherwise `lights` is null and the row says "Lights: can't
 * compare". Unknown is never zero.
 */
export interface RouteDelta {
  readonly time: { readonly figure: string; readonly unit: 'min' }
  readonly lights: { readonly figure: string; readonly unit: 'light' | 'lights' } | null
  readonly distance: { readonly figure: string; readonly unit: 'mi' }
}

export function routeDelta(recommended: RouteCandidate, other: RouteCandidate): RouteDelta | null {
  if (!Number.isFinite(recommended.durationSec) || !Number.isFinite(other.durationSec)) return null
  const minutes = Math.round((recommended.durationSec - other.durationSec) / 60)
  const a = knownSignals(recommended)
  const b = knownSignals(other)
  const miles = (recommended.distanceM - other.distanceM) / M_PER_MILE
  const roundedMiles = Math.abs(miles) >= 10 ? Math.round(miles) : Math.round(miles * 10) / 10
  const lights = a === null || b === null ? null : a - b
  return {
    time: { figure: signed(minutes), unit: 'min' },
    lights: lights === null ? null : { figure: signed(lights), unit: Math.abs(lights) === 1 ? 'light' : 'lights' },
    distance: { figure: signed(roundedMiles === 0 ? 0 : roundedMiles), unit: 'mi' },
  }
}
