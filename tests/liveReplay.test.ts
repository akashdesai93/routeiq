import { describe, expect, it } from 'vitest'
import {
  distanceM,
  synthesizeAnnouncements,
  type GuidanceStep,
  type LiveOptions,
  type LiveState,
  type LngLat,
  type PositionFix,
  type RouteCandidate,
  type SpokenLine,
} from '../src/core/index.ts'
import type { Speaker } from '../src/device/speech.ts'
import type { PageVisibility } from '../src/device/visibility.ts'
import type { ScreenWakeLock } from '../src/device/wakeLock.ts'
import {
  createReplaySource,
  DEFAULT_REPLAY_PLAN,
  replayFollow,
  replayStart,
  replayStep,
  type ReplayPlan,
} from '../src/drive/replay.ts'
import { DEFAULT_REPLAY_SETUP, replayPlanOf } from '../src/drive/replaySetup.ts'
import { createLiveRunner, type RoutesQuery } from '../src/live/runner.ts'
import { replayLiveOptions } from '../src/useLiveDrive.ts'
import { at, candidate, nameOf, type RouteName } from './helpers/driveWorld.ts'

// The whole loop without a browser: the replayed driver (the development position source)
// feeds the live runner through the same path as real GPS, on the made-up road network
// of helpers/driveWorld.ts, with time counted by hand. No network, no real timers.

const MAIN = candidate('A', at(0, 0), 1300)!.geometry

describe('the replayed driver', () => {
  const plan = (extra: Partial<ReplayPlan> = {}): ReplayPlan => ({ ...DEFAULT_REPLAY_PLAN, noiseM: 0, ...extra })
  /** Follows the main road for `seconds`, a fix a second. */
  function run(p: ReplayPlan, seconds: number, route: readonly LngLat[] = MAIN) {
    let state = replayFollow(replayStart(at(0, 0), p), route)
    const fixes: (PositionFix | null)[] = []
    for (let t = 1; t <= seconds; t++) {
      const step = replayStep(state, 1, t * 1000, p)
      state = step.state
      fixes.push(step.fix)
    }
    return { state, fixes }
  }

  it('waits at its origin until it has a route, then drives it at its speed', () => {
    const p = plan()
    const waiting = replayStep(replayStart(at(0, 0), p), 1, 1000, p)
    expect(waiting.fix).toMatchObject({ lng: at(0, 0)[0], lat: at(0, 0)[1], speedMps: 0, headingDeg: null, accuracyM: 8 })
    const { state, fixes } = run(p, 100)
    expect(state.alongM).toBeCloseTo(1500)
    expect(fixes.at(-1)).toMatchObject({ speedMps: 15, timeMs: 100_000 })
    expect(fixes.at(-1)!.headingDeg).toBeCloseTo(90, 0)
    expect(distanceM([fixes.at(-1)!.lng, fixes.at(-1)!.lat], at(1500, 0))).toBeLessThan(1)
  })

  it('adds seeded noise: the same replay every time, a different one for another seed', () => {
    const noisy = plan({ noiseM: 6 })
    const a = run(noisy, 200).fixes.map((f) => [f!.lng, f!.lat])
    expect(run(noisy, 200).fixes.map((f) => [f!.lng, f!.lat])).toEqual(a)
    expect(run({ ...noisy, seed: 2 }, 200).fixes.map((f) => [f!.lng, f!.lat])).not.toEqual(a)
    // Scattered around the true position by about the amount asked for.
    const offsets = run(noisy, 200).fixes.map((f, i) => distanceM([f!.lng, f!.lat], at(15 * (i + 1), 0)))
    const mean = offsets.reduce((sum, d) => sum + d, 0) / offsets.length
    expect(mean).toBeGreaterThan(4)
    expect(mean).toBeLessThan(11)
    expect(Math.max(...offsets)).toBeLessThan(30)
  })

  it('drops fixes in a dropout and in a tunnel, stops at a light, and reports no device speed when told so', () => {
    const { fixes, state } = run(plan({ dropoutsSec: [[20, 30]], tunnel: { fromM: 1200, toM: 1500 }, stop: { atM: 600, forSec: 40 } }), 150)
    const silent = fixes.map((f, i) => (f === null ? i + 1 : 0)).filter((t) => t > 0)
    // Seconds 20 to 29, then the tunnel: 600 m took 40 s, 40 s standing, 1200 m is reached at second 120.
    expect(silent.slice(0, 10)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
    expect(silent.slice(10)).toEqual(Array.from({ length: 20 }, (_, i) => 120 + i))
    // Standing at the light the device reports no speed and no heading.
    expect(fixes[60]).toMatchObject({ speedMps: 0, headingDeg: null })
    expect(state.alongM).toBeCloseTo(15 * 110)
    expect(run(plan({ deviceMotion: false }), 5).fixes.at(-1)).toMatchObject({ speedMps: null, headingDeg: null })
  })

  it('takes a wrong turn to the side, and is back on the road once it is given a new route', () => {
    const p = plan({ excursion: { atM: 300, offsetM: 150, maxSec: 90 } })
    let { state } = run(p, 40)
    // 20 s into the wrong turn: the full 150 m south of the road (to the right, heading east).
    expect(state.excursion).toEqual({ sinceSec: 20 })
    expect(distanceM(state.position, at(600, -150))).toBeLessThan(2)
    // The session found a new route from there.
    state = replayFollow(state, [state.position, at(900, 0), at(20_000, 0)])
    expect(state.excursion).toBe('done')
    expect(state.alongM).toBeCloseTo(0, 0)
    const next = replayStep(state, 10, 50_000, p)
    expect(distanceM(next.state.position, at(600 + 300 * (150 / Math.hypot(300, 150)), -150 + 150 * (150 / Math.hypot(300, 150))))).toBeLessThan(3)
    // Left alone, it comes back by itself after maxSec.
    expect(run(p, 115).state.excursion).toBe('done')
  })

  it('the panel setup turns into a plan', () => {
    expect(replayPlanOf(DEFAULT_REPLAY_SETUP, 22)).toMatchObject({ speedMps: 22, noiseM: 6, dropoutsSec: [], stop: null, tunnel: null, excursion: null })
    const all = replayPlanOf({ ...DEFAULT_REPLAY_SETUP, noise: false, dropouts: true, stop: true, tunnel: true, wrongTurn: true }, 15)
    expect(all).toMatchObject({ noiseM: 0, stop: { atM: 1500, forSec: 45 }, tunnel: { fromM: 6000, toM: 7500 }, excursion: { atM: 3000 } })
    expect(all.dropoutsSec).toHaveLength(2)
  })

  it('at 20x real requests stay 5 real seconds apart and the banner stays up as long as in real time', () => {
    expect(replayLiveOptions(20)).toEqual({ minRequestGapSec: 100, switchBannerSec: 160, pausedNoteSec: 300 })
    expect(replayLiveOptions(1).minRequestGapSec).toBe(10)
  })
})

/** Guidance for a route of the network: a turn at each corner, announced the made-up way. */
function guided(c: RouteCandidate): RouteCandidate {
  const guidance: GuidanceStep[] = c.maneuvers.map((m, i) => ({
    atDistanceM: m.atDistanceM,
    location: m.location,
    type: m.kind,
    modifier: m.kind === 'turn' ? 'left' : null,
    primaryText: `${nameOf(c)} road ${i}`,
    secondaryText: null,
    announcements:
      i === 0
        ? []
        : synthesizeAnnouncements(m.kind === 'arrive' ? 'Your destination is ahead.' : `Turn onto ${nameOf(c)} road ${i}.`, c.maneuvers[i - 1]!.atDistanceM, m.atDistanceM),
    synthesized: true,
  }))
  return { ...c, guidance }
}

interface World {
  /** The travel time of each route from a point `leftM` meters before its end, at drive time `tSec`. Null: not offered. */
  eta(name: RouteName, leftM: number, tSec: number): number | null
}

/**
 * A live drive run whole: the replay source on a hand-moved real clock, the runner, and
 * a made-up Directions service. Every 200 ms of real time is one tick; the run ends at
 * arrival or after `maxRealSec`.
 */
async function replayDrive(options: {
  plan: ReplayPlan
  multiplier: number
  world: World
  live?: Partial<LiveOptions>
  maxRealSec?: number
  /** Called once per tick with the drive time in seconds. */
  each?: (tSec: number, api: { runner: ReturnType<typeof createLiveRunner>; state: LiveState; setHidden: (hidden: boolean) => void }) => void
  /** A request sent at these drive times (seconds, rounded) fails. */
  failAt?: (tSec: number) => boolean
}) {
  let realMs = 0
  const timers: (() => void)[] = []
  const every = (_ms: number, fn: () => void) => {
    timers.push(fn)
    return () => {
      timers.splice(timers.indexOf(fn), 1)
    }
  }
  const source = createReplaySource({ origin: at(0, 0), plan: options.plan, multiplier: () => options.multiplier, realNow: () => realMs, every })
  const startMs = source.now()
  const tSec = () => (source.now() - startMs) / 1000

  const said: string[] = []
  const lines: SpokenLine[] = []
  const speaker: Speaker = {
    supported: true,
    say: (line) => {
      said.push(line.text)
      lines.push(line)
    },
    prime: (text) => said.push(text),
    setMuted: () => {},
    stop: () => {},
  }
  const wake: string[] = []
  const wakeLock: ScreenWakeLock = {
    acquire: () => {
      wake.push('acquire')
      return Promise.resolve('held')
    },
    release: () => {
      wake.push('release')
      return Promise.resolve()
    },
  }
  let hidden = false
  let onVisibility: ((hidden: boolean) => void) | null = null
  const visibility: PageVisibility = {
    isHidden: () => hidden,
    subscribe: (listener) => {
      onVisibility = listener
      return () => {
        onVisibility = null
      }
    },
  }

  const queries: (RoutesQuery & { tSec: number })[] = []
  const states: LiveState[] = []
  const busy: boolean[] = []
  const destination = at(20_000, 0)
  const runner = createLiveRunner({
    source,
    speaker,
    wakeLock,
    visibility,
    now: source.now,
    every,
    options: () => ({ ...replayLiveOptions(options.multiplier), ...options.live }),
    onChange: (state) => states.push(state),
    onBusy: (b) => {
      busy.push(b)
      source.hold(b)
    },
    routes: (query) => {
      const now = tSec()
      queries.push({ ...query, tSec: now })
      if (options.failAt?.(Math.round(now))) return Promise.resolve({ routes: null, message: 'Could not reach Mapbox.' })
      // The made-up service routes from the nearest point of each road, like a real one snaps to a road.
      const offered: RouteCandidate[] = []
      const current = query.driving === null ? 'A' : nameOf(query.driving.route)
      for (const name of [current, ...(['A', 'B', 'C'] as const).filter((n) => n !== current)]) {
        const whole = candidate(name, at(0, 0), 1)!
        const from = nearestOn(whole.geometry, query.origin)
        if (from === null) continue
        const made = candidate(name, from, 1)
        if (made === null) continue
        const sec = options.world.eta(name, made.distanceM, now)
        if (sec === null) continue
        if (offered.some((o) => Math.abs(o.distanceM - made.distanceM) < 1 && o.geometry.length === made.geometry.length)) continue
        offered.push(guided({ ...made, durationSec: sec, typicalDurationSec: sec }))
      }
      return Promise.resolve({ routes: offered })
    },
  })

  runner.start(destination)
  const maxTicks = ((options.maxRealSec ?? 600) * 1000) / 200
  for (let i = 0; i < maxTicks && runner.state().status !== 'arrived' && runner.state().status !== 'failed'; i++) {
    realMs += 200
    for (const fn of [...timers]) fn()
    // Let the answers of the made-up service arrive.
    for (let k = 0; k < 6; k++) await Promise.resolve()
    options.each?.(tSec(), {
      runner,
      state: runner.state(),
      setHidden: (next) => {
        hidden = next
        onVisibility?.(next)
      },
    })
  }
  return { runner, source, said, lines, wake, queries, states, busy, tSec, timers }
}

/** The vertex of a line within 60 m of `p` that is nearest to it, if any: a stand-in for snapping to a road. */
function nearestOn(line: readonly LngLat[], p: LngLat): LngLat | null {
  // The roads of the network have a vertex every 250 m: look along each piece.
  let best: { point: LngLat; d: number } | null = null
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!
    const b = line[i]!
    for (let k = 0; k <= 50; k++) {
      const point: LngLat = [a[0] + ((b[0] - a[0]) * k) / 50, a[1] + ((b[1] - a[1]) * k) / 50]
      const d = distanceM(point, p)
      if (best === null || d < best.d) best = { point, d }
    }
  }
  return best !== null && best.d <= 200 ? best.point : null
}

/** Every route at 15 m/s; the main road loses `delaySec` to traffic from `fromSec` on. */
const traffic = (fromSec: number, delaySec: number): World => ({
  eta: (name, leftM, tSec) => leftM / 15 + (name === 'A' && tSec >= fromSec ? delaySec : 0) + (name === 'A' ? 0 : 20),
})

describe('a whole replayed drive through the live runner', () => {
  it('a traffic change mid-way makes exactly one switch, and the spoken lines come in order', async () => {
    const drive = await replayDrive({
      plan: { ...DEFAULT_REPLAY_PLAN, noiseM: 5, seed: 7 },
      multiplier: 5,
      // Four minutes in, the main road ahead is suddenly six minutes slower (B is 2 km longer, so it saves about three and a half).
      world: traffic(100, 360),
    })
    const final = drive.runner.state()
    expect(final.status).toBe('arrived')
    expect(final.summary!.switches).toHaveLength(1)
    expect(final.summary!.switches[0]).toMatchObject({ code: 'faster-route' })
    expect(final.summary!.switches[0]!.reason).toMatch(/^Switching: saves 3\.\d minutes, turn in 1\.\d miles$/)

    expect(drive.said).toEqual([
      'RouteIQ started',
      expect.stringMatching(/^Switching to a faster route\. Saves 3\.\d minutes\. Turn in 1\.\d miles\.$/),
      'In 0.4 miles, turn onto B road 1.',
      'Turn onto B road 1.',
      'In 0.4 miles, turn onto B road 2.',
      'Turn onto B road 2.',
      'In 0.4 miles, turn onto B road 3.',
      'Turn onto B road 3.',
      'In 0.4 miles, turn onto B road 4.',
      'Turn onto B road 4.',
      'In 0.4 miles, your destination is ahead.',
      'Your destination is ahead.',
      expect.stringMatching(/^You have arrived\. Trip time 2\d minutes\. RouteIQ changed route once\.$/),
    ])
    // The switch is urgent; the turn prompts carry their distance for the queue rules.
    expect(drive.lines[0]).toMatchObject({ priority: 'urgent' })
    expect(drive.lines[1]).toMatchObject({ priority: 'turn' })

    // Confirmed over two checks a minute apart: seen at 120 s, switched at 180 s.
    const polls = drive.queries.filter((q) => q.purpose === 'poll').map((q) => Math.round(q.tSec))
    expect(polls.slice(0, 3)).toEqual([60, 120, 180])
    polls.forEach((t, i) => {
      if (i > 0) expect(t - polls[i - 1]!).toBeGreaterThanOrEqual(60)
    })
    expect(drive.queries[0]).toMatchObject({ purpose: 'plan', driving: null, headingDeg: null })
    expect(drive.queries.filter((q) => q.purpose === 'replan')).toEqual([])
    // Checks are asked from the road with the heading of travel, never more than the budget.
    expect(drive.queries[1]!.headingDeg).toBeCloseTo(90, 0)
    expect(final.summary!.requestsUsed).toBe(drive.queries.length)
    expect(drive.queries.length).toBeLessThanOrEqual(60)

    // The replayed car went where the session sent it: north onto B, and to the destination.
    expect(distanceM(drive.source.peek().position, at(20_000, 0))).toBeLessThan(60)
    expect(drive.states.some((s) => s.route !== null && nameOf(s.route) === 'B' && s.tracking !== null && s.tracking.position[1] > at(0, 900)[1])).toBe(true)
    // The clock was held for every request, and let go again.
    expect(drive.busy.filter((b) => b)).toHaveLength(drive.queries.length)
    expect(drive.busy.at(-1)).toBe(false)
    // Arrival let go of the device: the screen lock released, no timer or watch left running.
    expect(drive.wake).toEqual(['acquire', 'release'])
    expect(drive.timers).toHaveLength(0)
    // The car was never taken to be off the route, and progress never ran backwards on noise.
    expect(drive.states.every((s) => s.tracking === null || !s.tracking.offRoute)).toBe(true)
  })

  it('is the same drive every time', async () => {
    const run = () => replayDrive({ plan: { ...DEFAULT_REPLAY_PLAN, noiseM: 5, seed: 7 }, multiplier: 20, world: traffic(100, 360) })
    const [a, b] = [await run(), await run()]
    expect(a.said).toEqual(b.said)
    expect(a.queries.map((q) => [q.purpose, Math.round(q.tSec)])).toEqual(b.queries.map((q) => [q.purpose, Math.round(q.tSec)]))
    // At 20x the checks are at least 100 s of drive time apart: 5 real seconds.
    const polls = a.queries.filter((q) => q.purpose === 'poll').map((q) => q.tSec)
    polls.forEach((t, i) => {
      if (i > 0) expect(t - polls[i - 1]!).toBeGreaterThanOrEqual(100)
    })
    expect(a.runner.state().summary!.switches).toHaveLength(1)
  })

  it('without a traffic change nothing is said but the start, the turn prompts and the arrival', async () => {
    const drive = await replayDrive({ plan: { ...DEFAULT_REPLAY_PLAN, noiseM: 8, seed: 3 }, multiplier: 20, world: traffic(Infinity, 0) })
    expect(drive.runner.state().summary).toMatchObject({ switches: [], declined: 0 })
    expect(drive.said).toEqual([
      'RouteIQ started',
      'In 0.4 miles, your destination is ahead.',
      'Your destination is ahead.',
      expect.stringMatching(/^You have arrived\. Trip time 2\d minutes\.$/),
    ])
  })

  it('rides out noise, dropouts, a stop at a light and a tunnel without a false alarm', async () => {
    const drive = await replayDrive({
      plan: {
        ...DEFAULT_REPLAY_PLAN,
        noiseM: 10,
        seed: 11,
        deviceMotion: false,
        dropoutsSec: [[90, 110], [400, 425]],
        stop: { atM: 1500, forSec: 45 },
        tunnel: { fromM: 6000, toM: 7500 },
      },
      multiplier: 20,
      world: traffic(Infinity, 0),
    })
    const final = drive.runner.state()
    expect(final.status).toBe('arrived')
    expect(final.summary!.switches).toEqual([])
    expect(drive.queries.filter((q) => q.purpose === 'replan')).toEqual([])
    expect(drive.said).not.toContain('You are off the route. Finding a new one.')
    // Progress along the route never ran backwards.
    let last = 0
    for (const s of drive.states) {
      if (s.tracking === null || s.status !== 'driving') continue
      expect(s.tracking.alongRouteM).toBeGreaterThanOrEqual(last)
      last = s.tracking.alongRouteM
    }
    // No check was asked from inside the tunnel: the position there was stale.
    const inTunnel = drive.queries.filter((q) => {
      const x = (q.origin[0] - at(0, 0)[0]) / (at(1, 0)[0] - at(0, 0)[0])
      return x > 6100 && x < 7400
    })
    expect(inTunnel).toEqual([])
  })

  it('a wrong turn: says so once, replans at once from where the car is, and carries on', async () => {
    const drive = await replayDrive({
      plan: { ...DEFAULT_REPLAY_PLAN, noiseM: 4, seed: 5, excursion: { atM: 3000, offsetM: 150, maxSec: 120 } },
      multiplier: 5,
      world: traffic(Infinity, 0),
    })
    const final = drive.runner.state()
    expect(final.status).toBe('arrived')
    expect(drive.said.filter((line) => line === 'You are off the route. Finding a new one.')).toHaveLength(1)
    const replans = drive.queries.filter((q) => q.purpose === 'replan')
    expect(replans).toHaveLength(1)
    // The wrong turn starts 200 s in and drifts out over ten seconds: off the line (50 m)
    // after about four, three fixes of patience, and the request goes out at once.
    expect(replans[0]!.tSec).toBeGreaterThan(203)
    expect(replans[0]!.tSec).toBeLessThan(212)
    // Asked from where the device was, well off the road.
    expect(distanceM(replans[0]!.origin, at(3000 + 15 * (replans[0]!.tSec - 200), 0))).toBeGreaterThan(50)
    const order = drive.said.filter((line) => line.startsWith('You are off') || line.startsWith('New route'))
    expect(order).toEqual(['You are off the route. Finding a new one.', expect.stringMatching(/^New route\. 1\d minutes to your destination\.$/)])
    expect(final.summary!.switches.map((s) => s.code)).toEqual(['off-route'])
  })

  it('failed checks change nothing, and a spell in the background is noted and followed by a recheck', async () => {
    let hiddenAt: number | null = null
    let note: LiveState['pausedNote'] = null
    const drive = await replayDrive({
      plan: { ...DEFAULT_REPLAY_PLAN, noiseM: 3, seed: 2 },
      multiplier: 5,
      world: traffic(Infinity, 0),
      failAt: (t) => t >= 100 && t < 260,
      maxRealSec: 110,
      each: (t, { state, setHidden }) => {
        if (hiddenAt === null && t >= 300) {
          hiddenAt = t
          setHidden(true)
        } else if (hiddenAt !== null && hiddenAt > 0 && t >= hiddenAt + 95) {
          hiddenAt = -1
          setHidden(false)
        }
        note ??= state.pausedNote
      },
    })
    const polls = drive.queries.filter((q) => q.purpose === 'poll').map((q) => Math.round(q.tSec))
    // Failed at 120, 180 and 240: the cadence is unchanged, nothing was said.
    expect(polls.slice(0, 5)).toEqual([60, 120, 180, 240, 300])
    expect(drive.said).toEqual(['RouteIQ started'])
    // Hidden from 300 s for 95 s: no check in that time, one at once on return.
    expect(polls.filter((t) => t > 300 && t < 395)).toEqual([])
    expect(polls[5]).toBeGreaterThanOrEqual(395)
    expect(polls[5]).toBeLessThanOrEqual(397)
    expect(note).toMatchObject({ seconds: 95 })
    expect(drive.wake).toEqual(['acquire', 'acquire'])
    drive.runner.dispose()
    expect(drive.wake.at(-1)).toBe('release')
    expect(drive.timers).toHaveLength(0)
  })
})
