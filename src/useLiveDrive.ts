import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_LIVE_OPTIONS,
  LIVE_IDLE,
  liveView,
  type LiveOptions,
  type LiveState,
  type LiveView,
  type LngLat,
  type RerouteOptions,
} from './core/index.ts'
import { geolocationSource, type PositionSource } from './device/geolocation.ts'
import { createSpeaker, type Speaker } from './device/speech.ts'
import { pageVisibility } from './device/visibility.ts'
import { createWakeLock } from './device/wakeLock.ts'
import { fetchFreshRoutes } from './drive/freshRoutes.ts'
import { createReplaySource, type ReplayMultiplier, type ReplayPlan } from './drive/replay.ts'
import { MIN_REQUEST_GAP_MS, type DriveSettings } from './drive/simulation.ts'
import { createLiveRunner, type LiveRunner } from './live/runner.ts'

/** The development replay: a made-up driver in place of the device's GPS (see drive/replay.ts). */
export interface ReplayConfig {
  /** Where the made-up car starts. */
  readonly origin: LngLat
  readonly plan: ReplayPlan
  readonly multiplier: ReplayMultiplier
}

export interface LiveDriveConfig {
  readonly token: string | null
  readonly destination: LngLat
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
  const [speechSupported, setSpeechSupported] = useState(true)
  const runnerRef = useRef<{ runner: LiveRunner; now: () => number } | null>(null)
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
    const { token, destination, replay } = latest.current
    if (token === null) return
    runnerRef.current?.runner.dispose()
    const speaker = (speakerRef.current ??= createSpeaker())
    const replaySource = replay === null ? null : createReplaySource({ origin: replay.origin, plan: replay.plan, multiplier: () => latest.current.replay?.multiplier ?? replay.multiplier })
    const source: PositionSource = replaySource ?? geolocationSource()
    const now = replaySource === null ? Date.now : replaySource.now
    const multiplier = () => (replaySource === null ? null : (latest.current.replay?.multiplier ?? replay!.multiplier))
    let seenSwitches = 0
    const wakeLock = createWakeLock({ onReleased: () => runner.wakeLockReleased() })
    const runner: LiveRunner = createLiveRunner({
      source,
      speaker,
      wakeLock,
      visibility: pageVisibility(),
      now,
      every: (ms, fn) => {
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
        setState(next)
        setNowMs(now())
      },
      routes: async (query) => {
        const { token, whatIfDelaySec } = latest.current
        if (token === null) return { routes: null, message: 'No Mapbox token.' }
        const result = await fetchFreshRoutes({
          token,
          origin: query.origin,
          destination: query.destination,
          headingDeg: query.headingDeg,
          signal: query.signal,
          whatIf: query.driving !== null && whatIfDelaySec > 0 ? { ...query.driving, delaySec: whatIfDelaySec } : null,
        })
        if (!result.ok) return { routes: null, message: result.message }
        whatIfInPlay.current = result.simulated
        return { routes: result.candidates }
      },
    })
    runnerRef.current = { runner, now }
    setReplaying(replaySource !== null)
    setSpeechSupported(speaker.supported)
    runner.start(destination)
  }, [optionsOf])

  const end = useCallback(() => {
    runnerRef.current?.runner.dispose()
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
  const view = useMemo(
    () =>
      liveView(state, nowMs, {
        ...(multiplier === null ? {} : replayLiveOptions(multiplier)),
        pollIntervalSec: settings.pollIntervalSec,
        maxRequests: settings.maxRequests,
        reroute: rerouteOptions,
      }),
    [state, nowMs, multiplier, settings, rerouteOptions],
  )

  return {
    state,
    view,
    nowMs,
    canStart: config.token !== null,
    active: state.status !== 'idle',
    replaying,
    speechSupported,
    start,
    end,
    keepPrevious,
    setMuted,
  }
}
