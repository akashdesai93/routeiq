import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRACKING_OPTIONS,
  isUsableFix,
  retrack,
  trackedRoute,
  trackFix,
  type LngLat,
  type PositionFix,
  type TrackingState,
} from '../src/core/index.ts'
import { at, candidate } from './helpers/driveWorld.ts'

// Position tracking on the made-up road network of helpers/driveWorld.ts: a straight
// 20 km road running east (A), and a road that crosses itself. No real place, no clock.

const MAIN = trackedRoute(candidate('A', at(0, 0), 1300)!.geometry)

/** A fix `xM` east and `yM` north of the network's origin, taken `tSec` into the drive. */
function fix(xM: number, yM: number, tSec: number, extra: Partial<PositionFix> = {}): PositionFix {
  const [lng, lat] = at(xM, yM)
  return { lng, lat, accuracyM: 8, speedMps: null, headingDeg: null, timeMs: tSec * 1000, ...extra }
}

/** Feeds fixes one after another and returns the state after each. */
function follow(route: typeof MAIN, fixes: readonly PositionFix[], from: TrackingState | null = null): TrackingState[] {
  const states: TrackingState[] = []
  let state = from
  for (const f of fixes) {
    state = trackFix(state, route, f)
    if (state !== null) states.push(state)
  }
  return states
}

describe('tracking options', () => {
  it('has the documented defaults in one place', () => {
    expect(DEFAULT_TRACKING_OPTIONS).toMatchObject({
      maxAccuracyM: 50,
      offRouteM: 50,
      offRoutePatienceSec: 8,
      offRouteFixes: 3,
      arrivalRadiusM: 40,
    })
  })
})

describe('snapping and progress', () => {
  it('snaps a fix beside the road onto it and measures the distance along it', () => {
    const [state] = follow(MAIN, [fix(1000, 12, 0)])
    expect(state!.alongRouteM).toBeCloseTo(1000, 0)
    expect(state!.distanceFromRouteM).toBeCloseTo(12, 0)
    expect(state!.remainingM).toBeCloseTo(19_000, -1)
    // Drawn on the line, not where the device put it.
    expect(state!.position[1]).toBeCloseTo(at(1000, 0)[1], 6)
    expect(state!.offRoute).toBe(false)
  })

  it('noise never moves the car backwards', () => {
    // A car at 15 m/s whose fixes are thrown up to 12 m along and across the road, and a
    // stretch standing still where they scatter around one spot.
    const wobble = [9, -12, 4, -7, 11, -3, 8, -10, 2, -6]
    const fixes: PositionFix[] = []
    for (let t = 0; t < 60; t++) fixes.push(fix(15 * t + wobble[t % 10]!, wobble[(t + 3) % 10]!, t))
    for (let t = 60; t < 90; t++) fixes.push(fix(900 + wobble[t % 10]!, wobble[(t + 5) % 10]!, t))
    const states = follow(MAIN, fixes)
    states.forEach((s, i) => {
      if (i > 0) expect(s.alongRouteM).toBeGreaterThanOrEqual(states[i - 1]!.alongRouteM)
    })
    expect(states.every((s) => !s.offRoute && !s.reversing)).toBe(true)
    // One fix 25 m back is noise: the car stays where it was.
    const [ahead, back] = follow(MAIN, [fix(1000, 0, 0), fix(975, 0, 1)])
    expect(back!.alongRouteM).toBe(ahead!.alongRouteM)
  })

  it('a real U-turn does move it back, after a few fixes agree, and is then followed at once', () => {
    const states = follow(MAIN, [fix(1000, 0, 0), fix(960, 0, 1), fix(920, 0, 2), fix(880, 0, 3), fix(840, 0, 4), fix(860, 0, 5)])
    // Two fixes behind prove nothing; the third does.
    expect(states[1]!.alongRouteM).toBeCloseTo(1000, 0)
    expect(states[2]!.alongRouteM).toBeCloseTo(1000, 0)
    expect(states[3]!.alongRouteM).toBeCloseTo(880, 0)
    expect(states[3]!.reversing).toBe(true)
    expect(states[4]!.alongRouteM).toBeCloseTo(840, 0)
    // Forward again: back to normal.
    expect(states[5]!.alongRouteM).toBeCloseTo(860, 0)
    expect(states[5]!.reversing).toBe(false)
    // One stray fix far behind is forgotten when the next is where it should be.
    const stray = follow(MAIN, [fix(1000, 0, 0), fix(700, 0, 1), fix(1030, 0, 2)])
    expect(stray.map((s) => Math.round(s.alongRouteM))).toEqual([1000, 1000, 1030])
    expect(stray[2]!.jumpFixes).toBe(0)
  })

  it('on a route that crosses itself it takes the pass that fits the progress so far', () => {
    // East 1 km, north 500 m, west 500 m, then south across the first stretch at (500, 0):
    // the route passes that spot 500 m and 2500 m along.
    const corners: LngLat[] = [at(0, 0), at(1000, 0), at(1000, 500), at(500, 500), at(500, -500)]
    const loop = trackedRoute(corners)
    const first = follow(loop, [fix(470, 2, 0), fix(485, 2, 1), fix(500, 2, 2), fix(515, 2, 3)])
    expect(first.map((s) => Math.round(s.alongRouteM))).toEqual([470, 485, 500, 515])
    // Coming down the last stretch the same spot is 2500 m along.
    const second = follow(loop, [fix(502, 60, 100), fix(502, 30, 102), fix(502, 2, 104), fix(502, -28, 106)])
    expect(second.map((s) => Math.round(s.alongRouteM))).toEqual([2440, 2470, 2498, 2528])
    // The globally nearest point at (500, 2) on the way down would be the first pass.
    expect(second[2]!.offRoute).toBe(false)
    // A route taken up again with a hint lands on the pass the hint names.
    const hinted = trackFix(null, loop, fix(500, 1, 0), {}, 2480)
    expect(hinted!.alongRouteM).toBeCloseTo(2499, 0)
    expect(trackFix(null, loop, fix(500, 1, 0), {}, 480)!.alongRouteM).toBeCloseTo(500, 0)
  })

  it('carries on after a gap in the fixes (a tunnel), as far as the car could have driven', () => {
    const states = follow(MAIN, [fix(1000, 0, 0), fix(2500, 0, 60)])
    expect(states[1]!.alongRouteM).toBeCloseTo(2500, 0)
    // The same leap in one second is not believed at once.
    const leap = follow(MAIN, [fix(1000, 0, 0), fix(3000, 0, 1), fix(3015, 0, 2), fix(3030, 0, 3)])
    expect(leap.map((s) => Math.round(s.alongRouteM))).toEqual([1000, 1000, 1000, 3030])
  })
})

describe('fixes that are not good enough', () => {
  it('ignores a fix with poor accuracy, a fix that is not a coordinate, and one out of order', () => {
    const [good] = follow(MAIN, [fix(1000, 0, 10)])
    const poor = trackFix(good!, MAIN, fix(5000, 300, 11, { accuracyM: 80 }))!
    expect(poor).toEqual({ ...good!, ignoredFixes: 1 })
    expect(trackFix(good!, MAIN, { ...fix(1100, 0, 12), lat: 135 })!.alongRouteM).toBe(good!.alongRouteM)
    expect(trackFix(good!, MAIN, fix(1100, 0, 9))!.alongRouteM).toBe(good!.alongRouteM)
    // Nothing to fall back on yet: no state.
    expect(trackFix(null, MAIN, fix(1000, 0, 0, { accuracyM: 51 }))).toBeNull()
    expect(isUsableFix(fix(0, 0, 0, { accuracyM: 50 }))).toBe(true)
    expect(isUsableFix(fix(0, 0, 0, { accuracyM: 50.1 }))).toBe(false)
    // A device that gives no accuracy is taken on trust; the threshold can be set.
    expect(isUsableFix(fix(0, 0, 0, { accuracyM: NaN }))).toBe(true)
    expect(isUsableFix(fix(0, 0, 0, { accuracyM: 80 }), { maxAccuracyM: 100 })).toBe(true)
  })
})

describe('off route, with patience', () => {
  it('one fix off the line is never off route, and progress holds meanwhile', () => {
    const states = follow(MAIN, [fix(1000, 0, 0), fix(1015, 90, 1), fix(1030, 0, 2)])
    expect(states[1]!.offRoute).toBe(false)
    expect(states[1]!.offFixes).toBe(1)
    expect(states[1]!.distanceFromRouteM).toBeCloseTo(90, 0)
    expect(states[1]!.alongRouteM).toBeCloseTo(1000, 0)
    // Off the line the car is drawn where the device says it is.
    expect(states[1]!.position).toEqual(at(1015, 90))
    expect(states[2]).toMatchObject({ offRoute: false, offFixes: 0, offSinceMs: null })
    expect(states[2]!.alongRouteM).toBeCloseTo(1030, 0)
  })

  it('three good fixes in a row off the line are off route', () => {
    const states = follow(MAIN, [fix(1000, 0, 0), fix(1010, 80, 1), fix(1020, 85, 2), fix(1030, 90, 3)])
    expect(states.map((s) => s.offRoute)).toEqual([false, false, false, true])
    // A poor fix in between is not one of the three.
    const withPoor = follow(MAIN, [fix(1000, 0, 0), fix(1010, 80, 1), fix(1020, 400, 2, { accuracyM: 90 }), fix(1020, 85, 3)])
    expect(withPoor.at(-1)!.offRoute).toBe(false)
    // 50 m is still on the line; a little more is not.
    expect(follow(MAIN, [fix(1000, 49, 0)])[0]!.offFixes).toBe(0)
    expect(follow(MAIN, [fix(1000, 52, 0)])[0]!.offFixes).toBe(1)
  })

  it('or two fixes eight seconds apart, but never one fix however long it has been', () => {
    const slow = follow(MAIN, [fix(1000, 0, 0), fix(1010, 80, 1), fix(1040, 90, 9)])
    expect(slow.map((s) => s.offRoute)).toEqual([false, false, true])
    const sooner = follow(MAIN, [fix(1000, 0, 0), fix(1010, 80, 1), fix(1040, 90, 8)])
    expect(sooner.at(-1)!.offRoute).toBe(false)
    const single = follow(MAIN, [fix(1000, 0, 0), fix(1010, 80, 600)])
    expect(single.at(-1)!.offRoute).toBe(false)
    // The very first fix of a drive, far from the route, is one reading too.
    expect(follow(MAIN, [fix(1000, 300, 0)])[0]!.offRoute).toBe(false)
  })
})

describe('speed and heading', () => {
  it('uses the device speed when there is one, smoothed', () => {
    const states = follow(MAIN, [fix(0, 0, 0, { speedMps: 10 }), fix(10, 0, 1, { speedMps: 20 })])
    expect(states[0]!.speedMps).toBe(10)
    expect(states[1]!.speedMps).toBeCloseTo(14)
  })

  it('works the speed out from the fixes when the device gives none', () => {
    const fixes = Array.from({ length: 30 }, (_, t) => fix(15 * t, 0, t))
    const states = follow(MAIN, fixes)
    expect(states.at(-1)!.speedMps).toBeCloseTo(15, 0)
    expect(states.at(-1)!.stoppedSinceMs).toBeNull()
    // Standing still, with fixes scattering around one spot: the speed falls to nothing.
    const parked = follow(MAIN, Array.from({ length: 30 }, (_, i) => fix(435 + (i % 2 ? 6 : -6), i % 3, 30 + i)), states.at(-1)!)
    expect(parked.at(-1)!.speedMps).toBeLessThan(0.5)
    expect(parked.at(-1)!.stoppedSinceMs).not.toBeNull()
    expect(parked.at(-1)!.stoppedSinceMs).toBeLessThan(45_000)
  })

  it('takes the device heading while moving and the direction of the route otherwise', () => {
    const moving = follow(MAIN, [fix(0, 0, 0, { speedMps: 12, headingDeg: 84 })])
    expect(moving[0]!.headingDeg).toBe(84)
    // The road runs east.
    expect(follow(MAIN, [fix(500, 3, 0)])[0]!.headingDeg).toBeCloseTo(90, 0)
    // Standing still the device's heading points anywhere: the route's is kept.
    const still = follow(MAIN, [fix(500, 3, 0, { speedMps: 0, headingDeg: 200 })])
    expect(still[0]!.headingDeg).toBeCloseTo(90, 0)
  })
})

describe('arrival', () => {
  it('arrives within 40 m of the destination along the route, not before', () => {
    expect(follow(MAIN, [fix(19_900, 0, 0)])[0]!.arrived).toBe(false)
    expect(follow(MAIN, [fix(19_965, 5, 0)])[0]!.arrived).toBe(true)
    // Driven past the end.
    expect(follow(MAIN, [fix(20_030, 0, 0)])[0]!.arrived).toBe(true)
  })

  it('arrives beside the destination too (a car park), but only at the end of the route', () => {
    const parked = follow(MAIN, [fix(19_800, 0, 0), fix(19_990, 38, 13)])
    expect(parked[1]!.arrived).toBe(true)
    // A loop that starts where it ends has not arrived at its start.
    const loop = trackedRoute([at(0, 0), at(1000, 0), at(1000, 1000), at(0, 1000), at(0, 10)])
    expect(follow(loop, [fix(5, 0, 0)])[0]!.arrived).toBe(false)
    expect(follow(loop, [fix(5, 0, 0)])[0]!.alongRouteM).toBeCloseTo(5, 0)
  })
})

describe('retrack', () => {
  it('puts the car on another route where it is, keeping its speed', () => {
    const [on] = follow(MAIN, [fix(6000, 0, 0, { speedMps: 14 })])
    const other = trackedRoute(candidate('B', at(5000, 0), 900)!.geometry)
    // B turns north at 5 km; 6 km along A is nowhere near it.
    const off = retrack(on!, other)
    expect(off.offFixes).toBe(1)
    expect(off.offRoute).toBe(false)
    expect(off.speedMps).toBe(14)
    const fresh = trackedRoute(candidate('A', at(5900, 0), 900)!.geometry)
    expect(retrack(on!, fresh).alongRouteM).toBeCloseTo(100, 0)
  })

  it('prepares a geometry once', () => {
    const geometry = candidate('A', at(0, 0), 1300)!.geometry
    expect(trackedRoute(geometry)).toBe(trackedRoute(geometry))
    expect(trackedRoute(geometry).lengthM).toBeCloseTo(20_000, -2)
  })
})
