import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ETA_TIE_WINDOW_SEC,
  rankRoutes,
  recommendedRouteId,
  routeDelta,
  type RouteCandidate,
} from '../src/core/index.ts'

function route(
  id: string,
  durationSec: number,
  signalCount: number | null = null,
  distanceM = 9000,
): RouteCandidate {
  return {
    id,
    geometry: [
      [-80.84, 35.22],
      [-80.83, 35.15],
    ],
    durationSec,
    typicalDurationSec: null,
    distanceM,
    signalCount,
    signalCoverage: signalCount === null ? 'none' : 'full',
    providerSignalCount: null,
    intersections: null,
    limitedAccessSpansM: null,
    maneuvers: [],
  }
}

const order = (routes: readonly RouteCandidate[], etaTieWindowSec?: number) =>
  rankRoutes(routes, etaTieWindowSec === undefined ? {} : { etaTieWindowSec }).map((r) => r.route.id)

const reasons = (routes: readonly RouteCandidate[], etaTieWindowSec?: number) =>
  Object.fromEntries(
    rankRoutes(routes, etaTieWindowSec === undefined ? {} : { etaTieWindowSec }).map((r) => [
      r.route.id,
      r.reasons,
    ]),
  )

/** Every order the same routes can arrive in. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  )
}

describe('rankRoutes', () => {
  it('has one documented tie window, 30 seconds', () => {
    expect(DEFAULT_ETA_TIE_WINDOW_SEC).toBe(30)
  })

  it('puts a clear winner first whatever the signals say', () => {
    const routes = [route('slow', 1100, 2), route('fast', 900, 30), route('middle', 1000, 0)]
    const ranked = rankRoutes(routes)
    expect(ranked.map((r) => r.route.id)).toEqual(['fast', 'middle', 'slow'])
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3])
    // The routes themselves come back untouched, and the input is not reordered.
    expect(ranked[0]!.route).toBe(routes[1])
    expect(routes.map((r) => r.id)).toEqual(['slow', 'fast', 'middle'])
    expect(reasons(routes)).toEqual({
      fast: ['Fastest right now'],
      middle: ['2 min slower than the fastest'],
      slow: ['3 min slower than the fastest'],
    })
  })

  it('breaks an exact tie on signals, then distance, then id', () => {
    expect(order([route('a', 900, 12), route('b', 900, 9)])).toEqual(['b', 'a'])
    expect(reasons([route('a', 900, 12), route('b', 900, 9)])).toEqual({
      b: ['Tied for fastest, 3 fewer signals'],
      a: ['Tied for fastest, 3 more signals than the recommended route'],
    })
    // Same signals: the shorter one.
    expect(order([route('a', 900, 9, 9500), route('b', 900, 9, 9000)])).toEqual(['b', 'a'])
    expect(reasons([route('a', 900, 9, 9500), route('b', 900, 9, 9000)])).toEqual({
      b: ['Tied for fastest'],
      a: ['Tied for fastest, same number of signals as the recommended route'],
    })
    // Same everything: by id, so the answer never depends on the order they came in.
    expect(order([route('b', 900, 9), route('a', 900, 9)])).toEqual(['a', 'b'])
  })

  it('breaks a tie within the window on signals', () => {
    const routes = [route('fast', 900, 14), route('calm', 920, 11), route('far', 1000, 3)]
    expect(order(routes)).toEqual(['calm', 'fast', 'far'])
    expect(reasons(routes)).toEqual({
      calm: ['Within 30 s of the fastest, 3 fewer signals'],
      fast: ['Fastest right now, 3 more signals than the recommended route'],
      far: ['2 min slower than the fastest'],
    })
    // One signal reads as one signal.
    expect(reasons([route('fast', 900, 5), route('calm', 910, 4)])).toEqual({
      calm: ['Within 30 s of the fastest, 1 fewer signal'],
      fast: ['Fastest right now, 1 more signal than the recommended route'],
    })
    // Same count within the window: the faster one stays first.
    expect(reasons([route('fast', 900, 7), route('close', 915, 7)])).toEqual({
      fast: ['Fastest right now'],
      close: ['Within 30 s of the fastest, same number of signals as the recommended route'],
    })
    // More signals within the window never helps.
    expect(reasons([route('fast', 900, 7), route('close', 915, 9)])).toEqual({
      fast: ['Fastest right now'],
      close: ['Within 30 s of the fastest, 2 more signals than the recommended route'],
    })
  })

  it('treats exactly 30 s as a tie and 31 s as not', () => {
    expect(order([route('fast', 900, 10), route('calm', 930, 5)])).toEqual(['calm', 'fast'])
    expect(order([route('fast', 900, 10), route('calm', 931, 5)])).toEqual(['fast', 'calm'])
    expect(reasons([route('fast', 900, 10), route('calm', 931, 5)])).toEqual({
      fast: ['Fastest right now'],
      calm: ['31 s slower than the fastest'],
    })
    // A fraction over the window is over it.
    expect(order([route('fast', 900, 10), route('calm', 930.4, 5)])).toEqual(['fast', 'calm'])
    expect(reasons([route('fast', 900, 10), route('calm', 930.4, 5)]).calm).toEqual([
      '31 s slower than the fastest',
    ])
  })

  it('takes the window from its options', () => {
    const routes = [route('fast', 900, 10), route('calm', 960, 5)]
    expect(order(routes)).toEqual(['fast', 'calm'])
    expect(order(routes, 60)).toEqual(['calm', 'fast'])
    expect(reasons(routes, 60).calm).toEqual(['Within 60 s of the fastest, 5 fewer signals'])
    // No window: only exact ties are ties. Nonsense windows mean none.
    const close = [route('fast', 900, 10), route('calm', 901, 5), route('twin', 900, 8)]
    for (const window of [0, -30, NaN]) expect(order(close, window)).toEqual(['twin', 'fast', 'calm'])
    expect(reasons(close, 0)).toEqual({
      twin: ['Tied for fastest, 2 fewer signals'],
      fast: ['Tied for fastest, 2 more signals than the recommended route'],
      calm: ['1 s slower than the fastest'],
    })
  })

  it('measures the window from the fastest route only: ties do not chain', () => {
    // A is fastest. B is within 30 s of A with fewer signals. C is within 30 s
    // of B but 45 s behind A, so C is not tied with anything, though it has
    // the fewest signals of all.
    const a = route('A', 1000, 12)
    const b = route('B', 1020, 9)
    const c = route('C', 1045, 2)
    for (const routes of permutations([a, b, c])) {
      expect(order(routes)).toEqual(['B', 'A', 'C'])
    }
    expect(reasons([a, b, c])).toEqual({
      B: ['Within 30 s of the fastest, 3 fewer signals'],
      A: ['Fastest right now, 3 more signals than the recommended route'],
      C: ['45 s slower than the fastest'],
    })
  })

  it('never lets an unknown signal count win or lose a tiebreak', () => {
    // Unknown is fastest: a known count cannot beat it on signals.
    expect(order([route('unknown', 900, null), route('known', 920, 0)])).toEqual(['unknown', 'known'])
    // Unknown is slower: it cannot win on signals either.
    expect(order([route('known', 900, 40), route('unknown', 920, null)])).toEqual(['known', 'unknown'])
    // Nothing is said about signals where one side is unknown.
    expect(reasons([route('unknown', 900, null), route('known', 920, 0)])).toEqual({
      unknown: ['Fastest right now'],
      known: ['Within 30 s of the fastest'],
    })
    // Exact tie with an unknown: distance, then id.
    expect(order([route('known', 900, 3, 9500), route('unknown', 900, null, 9000)])).toEqual([
      'unknown',
      'known',
    ])
    expect(order([route('b', 900, 3), route('a', 900, null)])).toEqual(['a', 'b'])
  })

  it('treats a partial signal count as unknown: a lower bound cannot win or lose a tiebreak', () => {
    const partial = (id: string, durationSec: number, signalCount: number): RouteCandidate => ({
      ...route(id, durationSec, signalCount),
      signalCoverage: 'partial',
    })
    // "At least 2" is not fewer than 9: the fastest route stays first.
    expect(order([route('full', 900, 9), partial('partial', 920, 2)])).toEqual(['full', 'partial'])
    // And "at least 40" on the fastest route does not lose to a full count of 3.
    expect(order([partial('partial', 900, 40), route('full', 920, 3)])).toEqual(['partial', 'full'])
    expect(reasons([partial('partial', 900, 40), route('full', 920, 3)])).toEqual({
      partial: ['Fastest right now'],
      full: ['Within 30 s of the fastest'],
    })
    // The same numbers with full coverage do swap, so it is the coverage that held them.
    expect(order([route('a', 900, 40), route('b', 920, 3)])).toEqual(['b', 'a'])
    // Full counts are still compared around a partial one, which keeps the place its ETA gives it.
    expect(order([route('k1', 900, 9), partial('p', 910, 1), route('k2', 920, 4)])).toEqual(['k2', 'p', 'k1'])
    // A count marked as covering nothing is unknown too, whatever number it carries.
    const none: RouteCandidate = { ...route('none', 920, 0), signalCoverage: 'none' }
    expect(order([route('full', 900, 9), none])).toEqual(['full', 'none'])
  })

  it('still compares the known counts when one tied route is unknown, in every position', () => {
    // Fastest unknown: it stays first by ETA; the two known ones are ordered by signals.
    expect(order([route('u', 900, null), route('k1', 910, 9), route('k2', 920, 4)])).toEqual([
      'u',
      'k2',
      'k1',
    ])
    // Middle unknown: it keeps the second place its ETA gives it, and the known
    // routes swap around it. It is never recommended over the fastest route.
    const middle = [route('k1', 900, 9), route('u', 910, null), route('k2', 920, 4)]
    expect(order(middle)).toEqual(['k2', 'u', 'k1'])
    expect(reasons(middle)).toEqual({
      k2: ['Within 30 s of the fastest, 5 fewer signals'],
      u: ['Within 30 s of the fastest'],
      k1: ['Fastest right now, 5 more signals than the recommended route'],
    })
    // Slowest unknown: after the known ones it is slower than.
    expect(order([route('k1', 900, 9), route('k2', 910, 4), route('u', 920, null)])).toEqual([
      'k2',
      'k1',
      'u',
    ])
    expect(reasons([route('k1', 900, 9), route('k2', 910, 4), route('u', 920, null)])).toEqual({
      k2: ['Within 30 s of the fastest, 5 fewer signals'],
      k1: ['Fastest right now, 5 more signals than the recommended route'],
      u: ['Within 30 s of the fastest'],
    })
    // An unknown outside the window is just slower.
    expect(order([route('k1', 900, 9), route('k2', 910, 4), route('u', 990, null)])).toEqual([
      'k2',
      'k1',
      'u',
    ])
  })

  it('is plain ETA order when no signal count is known', () => {
    const routes = [route('c', 925), route('a', 900), route('b', 910), route('d', 1200)]
    expect(order(routes)).toEqual(['a', 'b', 'c', 'd'])
    expect(reasons(routes)).toEqual({
      a: ['Fastest right now'],
      b: ['Within 30 s of the fastest'],
      c: ['Within 30 s of the fastest'],
      d: ['5 min slower than the fastest'],
    })
    // NaN is as unknown as null.
    expect(order([route('a', 900, NaN), route('b', 910, 0)])).toEqual(['a', 'b'])
  })

  it('handles a single route and an empty list', () => {
    const only = route('only', 500, 7)
    expect(rankRoutes([only])).toEqual([{ route: only, rank: 1, reasons: ['Only route found'] }])
    expect(rankRoutes([])).toEqual([])
    expect(recommendedRouteId([only])).toBe('only')
    expect(recommendedRouteId([])).toBeNull()
  })

  it('gives the same ranking for every input order', () => {
    const sets = [
      [route('a', 900, 12), route('b', 900, 12), route('c', 915, 12), route('d', 2000, 0)],
      [route('a', 900, null), route('b', 905, 3), route('c', 910, null), route('d', 925, 1)],
      [route('a', 900, 5, 9000), route('b', 900, 5, 9000), route('c', 900, null, 9000)],
    ]
    for (const set of sets) {
      const expected = rankRoutes(set)
      expect(expected.map((r) => r.rank)).toEqual(set.map((_, i) => i + 1))
      for (const shuffled of permutations(set)) {
        expect(rankRoutes(shuffled)).toEqual(expected)
      }
    }
  })

  it('says a slower route in whole minutes, or seconds under a minute', () => {
    const slower = (sec: number) => reasons([route('fast', 900), route('slow', 900 + sec)]).slow
    expect(slower(45)).toEqual(['45 s slower than the fastest'])
    expect(slower(59)).toEqual(['59 s slower than the fastest'])
    expect(slower(60)).toEqual(['1 min slower than the fastest'])
    expect(slower(125)).toEqual(['2 min slower than the fastest'])
    expect(slower(3900)).toEqual(['1 h 5 min slower than the fastest'])
  })

  it('puts a route without a usable travel time last and never recommends it over a real one', () => {
    const routes = [route('broken', NaN, 0), route('real', 5000, 40)]
    expect(order(routes)).toEqual(['real', 'broken'])
    expect(reasons(routes)).toEqual({
      real: ['Fastest right now'],
      broken: ['No travel time available'],
    })
  })

  it('recommends the top-ranked route', () => {
    expect(recommendedRouteId([route('a', 900), route('b', 840), route('c', 1020)])).toBe('b')
    expect(recommendedRouteId([route('fast', 900, 14), route('calm', 920, 11)])).toBe('calm')
    expect(recommendedRouteId([route('fast', 900, 14), route('calm', 920, 11)], { etaTieWindowSec: 0 })).toBe(
      'fast',
    )
  })
})

describe('routeDelta: the delta row of the route list', () => {
  const MI = 1609.344
  it('says what the recommended route gives against another: minutes, lights and miles, each signed', () => {
    const best = route('a', 35 * 60, 21, 21 * MI)
    const other = route('b', 43 * 60, 23, 24 * MI)
    expect(routeDelta(best, other)).toEqual({
      time: { figure: '\u22128', unit: 'min' },
      lights: { figure: '\u22122', unit: 'lights' },
      distance: { figure: '\u22123', unit: 'mi' },
    })
  })

  it('a longer or busier recommended route says so with a plus; one light is singular; under 10 miles keeps a tenth', () => {
    const best = route('a', 35 * 60, 22, 9.4 * MI)
    const other = route('b', 41 * 60, 21, 7.1 * MI)
    expect(routeDelta(best, other)).toEqual({
      time: { figure: '\u22126', unit: 'min' },
      lights: { figure: '+1', unit: 'light' },
      distance: { figure: '+2.3', unit: 'mi' },
    })
  })

  it('never compares lights unless both counts are full: partial and unknown give null, never 0', () => {
    const best = route('a', 35 * 60, 9)
    const partial = { ...route('b', 43 * 60, 9), signalCoverage: 'partial' as const }
    expect(routeDelta(best, partial)!.lights).toBeNull()
    expect(routeDelta(best, route('c', 43 * 60, null))!.lights).toBeNull()
    expect(routeDelta(route('d', 35 * 60, null), route('e', 43 * 60, 9))!.lights).toBeNull()
  })

  it('a tie reads 0, not a signed zero', () => {
    expect(routeDelta(route('a', 600, 5, 9000), route('b', 610, 5, 9010))).toEqual({
      time: { figure: '0', unit: 'min' },
      lights: { figure: '0', unit: 'lights' },
      distance: { figure: '0', unit: 'mi' },
    })
  })

  it('no figure from a travel time that is not a number', () => {
    expect(routeDelta(route('a', Number.NaN), route('b', 600))).toBeNull()
  })
})
