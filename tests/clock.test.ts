import { describe, expect, it } from 'vitest'
import type { LiveState } from '../src/core/index.ts'
import { steadyClock } from '../src/device/clock.ts'
import { geolocationSource, type GeolocationLike } from '../src/device/geolocation.ts'
import type { Speaker } from '../src/device/speech.ts'
import { createLiveRunner } from '../src/live/runner.ts'
import { at, candidate } from './helpers/driveWorld.ts'

// The live drive's clock (#30): it follows the wall clock forward and never steps back with it.

describe('the session clock', () => {
  it('follows the wall clock forward, time asleep included', () => {
    let wall = 1_000_000
    const clock = steadyClock(() => wall)
    expect(clock.now()).toBe(1_000_000)
    wall += 1000
    expect(clock.now()).toBe(1_001_000)
    // Ten minutes with the phone asleep still count.
    wall += 600_000
    expect(clock.now()).toBe(1_601_000)
  })

  it('absorbs a step back of the wall clock: it carries on from where it was', () => {
    let wall = 1_000_000
    const clock = steadyClock(() => wall)
    clock.now()
    wall += 5000
    expect(clock.now()).toBe(1_005_000)
    // The wall clock is put back 30 s (NTP, the carrier, a hand). The session clock does not move back.
    wall -= 30_000
    // 1 ms on, so a fix stamped now is still newer than the last.
    expect(clock.now()).toBe(1_005_001)
    wall += 1000
    expect(clock.now()).toBe(1_006_001)
    // A second step back adds to the first.
    wall -= 10_000
    expect(clock.now()).toBe(1_006_002)
    wall += 2000
    expect(clock.now()).toBe(1_008_002)
    // The arrival time is shown on the wall clock.
    expect(clock.toWall(clock.now() + 60_000)).toBe(wall + 60_000)
  })

  it('a step forward is followed (the wall clock was behind), and a value that is not a time is skipped', () => {
    let wall = 1_000_000
    const clock = steadyClock(() => wall)
    clock.now()
    wall += 3_600_000
    expect(clock.now()).toBe(4_600_000)
    wall = Number.NaN
    expect(clock.now()).toBe(4_600_000)
    wall = 4_601_000
    expect(clock.now()).toBe(4_601_000)
  })
})

/** A stand-in for navigator.geolocation whose watch can be fed fixes by hand. */
function watchedGeolocation() {
  let push: ((position: { coords: { longitude: number; latitude: number; accuracy: number; speed: number | null; heading: number | null } }) => void) | null = null
  const geolocation: GeolocationLike = {
    getCurrentPosition() {},
    watchPosition(success) {
      push = success as typeof push
      return 1
    },
    clearWatch() {},
  }
  const fix = (xM: number) => {
    const [longitude, latitude] = at(xM, 0)
    push!({ coords: { longitude, latitude, accuracy: 8, speed: null, heading: null } })
  }
  return { geolocation, fix }
}

const settle = async () => {
  for (let k = 0; k < 10; k++) await Promise.resolve()
}

/**
 * A drive through the runner with the browser's GPS source, both on `clock`, at 15 m/s on the
 * main road. At 100 s (1500 m) the wall clock is put back 30 s; the car drives on for 20 s.
 * Returns how far along the route the session has the car.
 */
async function driveThroughAStepBack(clock: (wall: () => number) => () => number): Promise<LiveState> {
  let wall = 1_700_000_000_000
  const now = clock(() => wall)
  const { geolocation, fix } = watchedGeolocation()
  const ticks: (() => void)[] = []
  const speaker: Speaker = { supported: true, say: () => {}, prime: () => {}, setMuted: () => {}, stop: () => {} }
  const runner = createLiveRunner({
    source: geolocationSource({ geolocation, secureContext: true, now }),
    speaker,
    wakeLock: { acquire: () => Promise.resolve('held'), release: () => Promise.resolve() },
    visibility: { isHidden: () => false, subscribe: () => () => {} },
    now,
    every: (_ms, fn) => {
      ticks.push(fn)
      return () => {}
    },
    options: () => ({}),
    onChange: () => {},
    // The first route is the main road; a check fails (it changes nothing here).
    routes: (query) => Promise.resolve({ routes: query.purpose === 'plan' ? [candidate('A', at(0, 0), 1300)!] : null }),
  })
  runner.start(at(20_000, 0))
  fix(0)
  await settle()
  expect(runner.state().status).toBe('driving')
  for (let t = 1; t <= 120; t++) {
    wall += 1000
    if (t === 101) wall -= 30_000
    fix(15 * t)
    ticks.forEach((tick) => tick())
    await settle()
  }
  const state = runner.state()
  runner.dispose()
  return state
}

describe('a wall clock that steps back during a drive (#30)', () => {
  it('the car follows the fixes, on the session clock', async () => {
    const state = await driveThroughAStepBack((wall) => steadyClock(wall).now)
    expect(state.tracking!.alongRouteM).toBeGreaterThan(1700)
    expect(state.tracking!.alongRouteM).toBeCloseTo(1800, -1)
    expect(state.tracking!.ignoredFixes).toBe(0)
  })

  it('on the wall clock itself, the car would stand still for as long as the step (the bug)', async () => {
    const state = await driveThroughAStepBack((wall) => wall)
    expect(state.tracking!.alongRouteM).toBeLessThan(1550)
    expect(state.tracking!.ignoredFixes).toBeGreaterThanOrEqual(19)
  })
})
