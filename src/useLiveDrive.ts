import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_LIVE_OPTIONS,
  isValidLngLat,
  LIVE_IDLE,
  liveView,
  type LiveOptions,
  type LiveState,
  type LiveView,
  type LngLat,
  type RerouteOptions,
  type RouteCandidate,
} from './core/index.ts'
import { sessionClock, sessionNow } from './device/clock.ts'
import { geolocationSource, type PositionSource } from './device/geolocation.ts'
import { nativeDevice } from './device/native/index.ts'
import { createSpeaker, type Speaker } from './device/speech.ts'
import { pageVisibility } from './device/visibility.ts'
import { createWakeLock } from './device/wakeLock.ts'
import { fetchFreshRoutes } from './drive/freshRoutes.ts'
import { createReplaySource, type ReplayMultiplier, type ReplayPlan } from './drive/replay.ts'
import { MIN_REQUEST_GAP_MS, type DriveSettings } from './drive/simulation.ts'
import type { TestDrivePreset } from './drive/testDrive.ts'
import { createLiveRunner, type LiveRunner } from './live/runner.ts'
import type { DriveObserver } from './useDriveLog.ts'

/** The development replay: a made-up driver in place of the device's GPS (see drive/replay.ts). */
export interface ReplayConfig {
  /** Where the made-up car starts. */
  readonly origin: LngLat
  readonly plan: ReplayPlan
  readonly multiplier: ReplayMultiplier
}

/** The iPhone app's test drive: a made-up car moved by the app's native code (see drive/testDrive.ts). */
export interface TestDriveConfig {
  /** Where the car starts when no route is picked. With one, it starts at the route's start. */
  readonly origin: LngLat
  readonly preset: TestDrivePreset
  readonly multiplier: number
}

export interface LiveDriveConfig {
  readonly token: string | null
  readonly destination: LngLat
  /** The route picked on the plan screen: Start drive drives it (a side-street route too). Read at Start only. */
  readonly route: RouteCandidate | null
  /** When Mapbox's answer with that route's travel times came, on the session clock (device/clock.ts). Read at Start only. */
  readonly routeFetchedAtMs?: number | null
  /** The reroute thresholds, shared with the simulated drive's settings box. */
  readonly rerouteOptions: RerouteOptions
  /** The poll interval and the request budget, shared with the simulated drive's. */
  readonly settings: DriveSettings
  /** The development what-if delay on the route being driven, in seconds. 0 for none. */
  readonly whatIfDelaySec: number
  /** Called after a switch made with a what-if delay in play: the delay applied to the route just left. */
  readonly onWhatIfSpent: () => void
  /** Null: the device's GPS. */
  readonly replay: ReplayConfig | null
  /** Inside the iPhone shell only: a test drive in place of the GPS. Null or left out: the GPS. Read at Start. */
  readonly testDrive?: TestDriveConfig | null
  /** Told about each drive on the device's own position (not a development replay): the private drive log. */
  readonly observer?: DriveObserver
}

export interface LiveDrive {
  readonly state: LiveState
  readonly view: LiveView
  /** The session clock's time when the view was made (drive time during a replay). */
  readonly nowMs: number
  /** False without a token. */
  readonly canStart: boolean
  /** True while the drive view is to be shown (from Start until End, a failure and the summary included). */
  readonly active: boolean
  readonly replaying: boolean
  /** True during the iPhone app's test drive: the positions are made up. */
  readonly simulated: boolean
  readonly speechSupported: boolean
  /** Call from inside the tap handler. */
  readonly start: () => void
  readonly end: () => void
  readonly keepPrevious: () => void
  readonly setMuted: (muted: boolean) => void
}

/** The live-drive options for a replay running `multiplier` times as fast as real time. */
export function replayLiveOptions(multiplier: number): Partial<LiveOptions> {
  const d = DEFAULT_LIVE_OPTIONS
  return {
    // Real requests stay at least 5 real seconds apart, as in the simulated drive.
    minRequestGapSec: Math.max(d.minRequestGapSec, (MIN_REQUEST_GAP_MS / 1000) * multiplier),
    // What is there to be read or pressed stays up as long as it would in real time.
    switchBannerSec: d.switchBannerSec * multiplier,
    pausedNoteSec: d.pausedNoteSec * multiplier,
    // A real request gets as long in real time as on the road before it is given up.
    requestTimeoutSec: d.requestTimeoutSec * multiplier,
  }
}

/**
 * The live drive as React state. Orchestrates only: the rules are
 * core/live.ts, the effects are carried out by live/runner.ts, and the
 * browser sits behind the wrappers in src/device. One runner per drive: the
 * device's GPS on the wall clock, or (development) the replay on its own.
 *
 * The position stays in memory: it is never written to the place book, the
 * recents or the pins, and never logged.
 */
export function useLiveDrive(config: LiveDriveConfig): LiveDrive {
  const [state, setState] = useState<LiveState>(LIVE_IDLE)
  const [nowMs, setNowMs] = useState(0)
  const [replaying, setReplaying] = useState(false)
  const [simulated, setSimulated] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(true)
  const runnerRef = useRef<{ runner: LiveRunner; now: () => number; observer: DriveObserver | undefined } | null>(null)
  const speakerRef = useRef<Speaker | null>(null)
  const latest = useRef(config)
  const whatIfInPlay = useRef(false)
  useEffect(() => {
    latest.current = config
  })

  const optionsOf = useCallback((multiplier: number | null): Partial<LiveOptions> => {
    const { settings, rerouteOptions } = latest.current
    return {
      ...(multiplier === null ? {} : replayLiveOptions(multiplier)),
      pollIntervalSec: settings.pollIntervalSec,
      maxRequests: settings.maxRequests,
      reroute: rerouteOptions,
    }
  }, [])

  const start = useCallback(() => {
    const { token, destination, route, replay, testDrive = null, routeFetchedAtMs = null } = latest.current
    if (token === null) return
    // "Try again" after a failure ends the drive that was under way: the log keeps it as ended.
    const previous = runnerRef.current
    previous?.observer?.end(previous.runner.state(), previous.now())
    previous?.runner.dispose()
    // Inside the iPhone shell the GPS, the voice, the screen lock and the clock's ticks are native,
    // and go on with the phone locked (src/device/native). In a browser: the browser's own.
    // A test drive swaps the GPS for a made-up car that the native side moves; the clock stays real.
    const native = nativeDevice(
      replay === null && testDrive !== null
        ? { origin: route?.geometry.find(isValidLngLat) ?? testDrive.origin, preset: testDrive.preset, multiplier: testDrive.multiplier }
        : null,
    )
    const speaker = (speakerRef.current ??= native?.speaker ?? createSpeaker())
    const replaySource = replay === null ? null : createReplaySource({ origin: replay.origin, plan: replay.plan, multiplier: () => latest.current.replay?.multiplier ?? replay.multiplier })
    const source: PositionSource = replaySource ?? native?.source ?? geolocationSource()
    // The session clock never steps back with the wall clock (#30); the GPS sources stamp with it too.
    const now = replaySource === null ? sessionNow : replaySource.now
    const multiplier = () => (replaySource === null ? null : (latest.current.replay?.multiplier ?? replay!.multiplier))
    let seenSwitches = 0
    // A development replay and the shell's test drive are made-up drives: they are not logged.
    const observer = replaySource === null && testDrive === null ? latest.current.observer : undefined
    observer?.start()
    const wakeLock = native?.wakeLock ?? createWakeLock({ onReleased: () => runner.wakeLockReleased() })
    const runner: LiveRunner = createLiveRunner({
      source,
      speaker,
      wakeLock,
      // A replay has no GPS to lose, but it runs on the page's timers: it keeps the browser's rule.
      visibility: replaySource === null && native !== null ? native.visibility : pageVisibility(),
      now,
      every: (ms, fn) => {
        if (replaySource === null && native !== null) return native.every(ms, fn)
        // A replay at 20x needs the session asked more often than once a real second.
        const id = setInterval(fn, replaySource === null ? ms : 200)
        return () => clearInterval(id)
      },
      options: () => optionsOf(multiplier()),
      onBusy: (busy) => replaySource?.hold(busy),
      onChange: (next) => {
        if (runnerRef.current?.runner !== runner) return
        if (next.switches.length > seenSwitches && whatIfInPlay.current) {
          whatIfInPlay.current = false
          latest.current.onWhatIfSpent()
        }
        seenSwitches = next.switches.length
        const at = now()
        observer?.change(next, at)
        setState(next)
        setNowMs(at)
      },
      routes: async (query) => {
        const { token, whatIfDelaySec, rerouteOptions } = latest.current
        if (token === null) return { routes: null, message: 'No Mapbox token.' }
        const result = await fetchFreshRoutes({
          token,
          origin: query.origin,
          destination: query.destination,
          headingDeg: query.headingDeg,
          signal: query.signal,
          whatIf: query.driving !== null && whatIfDelaySec > 0 ? { ...query.driving, delaySec: whatIfDelaySec } : null,
          baseline: query.driving !== null && query.baseline ? { ...query.driving, rerouteOptions } : null,
          probes:
            query.driving !== null && query.probes.allowed > 0
              ? {
                  ...query.driving,
                  allowed: query.probes.allowed,
                  memory: query.probes.memory,
                  rerouteOptions,
                  timeoutMs: query.probes.budget.timeoutSec * 1000,
                  minDelaySec: query.probes.budget.minDelaySec,
                }
              : null,
          onRequest: query.onRequest,
        })
        if (!result.ok) return { routes: null, message: result.message }
        whatIfInPlay.current = result.simulated
        return { routes: result.candidates, baseline: result.baseline, requests: result.requests, probes: result.probeRequests }
      },
    })
    runnerRef.current = { runner, now, observer }
    setReplaying(replaySource !== null)
    setSimulated(replaySource === null && native !== null && native.simulated)
    setSpeechSupported(speaker.supported)
    // A replay runs on its own clock: the plan's time means nothing on it.
    runner.start(destination, route, replaySource === null ? routeFetchedAtMs : null)
  }, [optionsOf])

  const end = useCallback(() => {
    const current = runnerRef.current
    current?.observer?.end(current.runner.state(), current.now())
    current?.runner.dispose()
    runnerRef.current = null
    setState(LIVE_IDLE)
  }, [])
  const keepPrevious = useCallback(() => runnerRef.current?.runner.keepPrevious(), [])
  const setMuted = useCallback((muted: boolean) => runnerRef.current?.runner.setMuted(muted), [])

  // "Checked N s ago" moves on between events.
  const ticking = state.status === 'driving'
  useEffect(() => {
    if (!ticking) return
    const id = setInterval(() => {
      const current = runnerRef.current
      if (current !== null) setNowMs(current.now())
    }, 1000)
    return () => clearInterval(id)
  }, [ticking])

  // A drive does not outlive the page it was started on.
  useEffect(() => () => runnerRef.current?.runner.dispose(), [])

  const multiplier = replaying ? (config.replay?.multiplier ?? null) : null
  const { settings, rerouteOptions } = config
  const view = useMemo(() => {
    const v = liveView(state, nowMs, {
      ...(multiplier === null ? {} : replayLiveOptions(multiplier)),
      pollIntervalSec: settings.pollIntervalSec,
      maxRequests: settings.maxRequests,
      reroute: rerouteOptions,
    })
    // The arrival time is shown as a time of day: on the wall clock, whatever the session clock absorbed.
    return replaying || v.arrivalAtMs === null ? v : { ...v, arrivalAtMs: sessionClock.toWall(v.arrivalAtMs) }
  }, [state, nowMs, multiplier, settings, rerouteOptions, replaying])

  return {
    state,
    view,
    nowMs,
    canStart: config.token !== null,
    active: state.status !== 'idle',
    replaying,
    simulated,
    speechSupported,
    start,
    end,
    keepPrevious,
    setMuted,
  }
}
