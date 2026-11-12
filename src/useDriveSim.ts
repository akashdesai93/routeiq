import { useCallback, useEffect, useRef, useState } from 'react'
import {
  alongRouteM,
  checkProbeAllowance,
  decideReroute,
  DEFAULT_REROUTE_OPTIONS,
  findCurrentRoute,
  formatDistance,
  formatDuration,
  INITIAL_CHECK_PROBES,
  INITIAL_REROUTE_STATE,
  pointAtDistance,
  rankRoutes,
  rememberCheckProbes,
  type CheckProbeMemory,
  type LngLat,
  type RankedRoute,
  type RerouteOptions,
  type RerouteState,
  type RouteCandidate,
  type RouteSignal,
} from './core/index.ts'
import { fetchFreshRoutes } from './drive/freshRoutes.ts'
import {
  advance,
  afterRequest,
  afterSwitch,
  cruiseSpeedMps,
  DEFAULT_DRIVE_SETTINGS,
  DRIVE_START,
  MIN_REQUEST_GAP_MS,
  pollGate,
  type DriveClock,
  type DriveLogEntry,
  type DriveSettings,
  type SpeedMultiplier,
} from './drive/simulation.ts'

export type DriveStatus = 'idle' | 'running' | 'paused' | 'arrived'

/** What there is to show of a simulated drive, republished several times a second while it runs. */
export interface DriveView {
  readonly simTimeSec: number
  /** Where the simulated car is. */
  readonly car: LngLat
  /** The route being driven, whole: the same array until the route changes. */
  readonly route: readonly LngLat[]
  /** How far along `route` the car is, in meters. */
  readonly alongM: number
  readonly remainingM: number
  /** Directions requests this drive has made. */
  readonly requestsUsed: number
  /** True while a poll is out; the simulated clock waits for it. */
  readonly polling: boolean
  /** The routes the last answered poll returned (what-if delay included). Null before the first. */
  readonly candidates: readonly RouteCandidate[] | null
  readonly ranked: readonly RankedRoute[]
  /** Which of `candidates` is the route being driven. Null when none is. */
  readonly currentCandidateId: string | null
  /** Signals on that candidate, for the map. */
  readonly signals: readonly RouteSignal[]
  /** Where a switch that is waiting (pending) or was just made leaves the old route. */
  readonly turn: { readonly at: LngLat; readonly pending: boolean } | null
  /** Newest last. */
  readonly log: readonly DriveLogEntry[]
}

export interface DriveSim {
  readonly status: DriveStatus
  /** Null while no drive is on (idle). */
  readonly view: DriveView | null
  readonly multiplier: SpeedMultiplier
  readonly setMultiplier: (m: SpeedMultiplier) => void
  readonly settings: DriveSettings
  readonly setSettings: (s: DriveSettings) => void
  readonly rerouteOptions: RerouteOptions
  readonly setRerouteOptions: (o: RerouteOptions) => void
  /** The what-if delay that is added to the current route's ETA from the next poll on, in seconds. 0 for none. */
  readonly whatIfDelaySec: number
  readonly setWhatIfDelaySec: (sec: number) => void
  /** False without a token or a route to drive. */
  readonly canStart: boolean
  readonly start: () => void
  readonly pause: () => void
  readonly resume: () => void
  readonly stop: () => void
}

/** How often the simulated clock is moved on and the view republished, in real milliseconds. */
const TICK_MS = 100
const MAX_LOG_LINES = 300

/** One drive's working state. Lives in a ref: only this file touches it. */
interface Run {
  route: RouteCandidate
  routeLengthM: number
  speedMps: number
  clock: DriveClock
  engine: RerouteState
  /** The side-street probes of the checks (core probe.ts). */
  probes: CheckProbeMemory
  /** Set while a poll is out. */
  inFlight: AbortController | null
  candidates: readonly RouteCandidate[] | null
  currentCandidateId: string | null
  signals: readonly RouteSignal[]
  turn: DriveView['turn']
  log: DriveLogEntry[]
  budgetNoted: boolean
}

const NO_SIGNALS: readonly RouteSignal[] = []

function viewOf(run: Run): DriveView {
  return {
    simTimeSec: run.clock.simTimeSec,
    car: pointAtDistance(run.route.geometry, run.clock.alongM)?.point ?? run.route.geometry[0]!,
    route: run.route.geometry,
    alongM: run.clock.alongM,
    remainingM: Math.max(0, run.routeLengthM - run.clock.alongM),
    requestsUsed: run.clock.requestsUsed,
    polling: run.inFlight !== null,
    candidates: run.candidates,
    ranked: run.candidates === null ? [] : rankRoutes(run.candidates),
    currentCandidateId: run.currentCandidateId,
    signals: run.signals,
    turn: run.turn,
    log: run.log,
  }
}

function addLog(run: Run, kind: DriveLogEntry['kind'], text: string, simulated = false): void {
  const id = (run.log.at(-1)?.id ?? 0) + 1
  run.log = [...run.log, { id, simTimeSec: run.clock.simTimeSec, kind, text, simulated }].slice(-MAX_LOG_LINES)
}

/**
 * The simulated drive (PLAN step 6): a car moves along the selected route on
 * a simulated clock; every `pollIntervalSec` of simulated time Mapbox is
 * asked for routes from the car's position (with its heading), the reroute
 * engine (core/reroute.ts) decides, and a switch is applied by itself. This
 * hook only orchestrates: the rules are the engine's, the clock and the
 * request budget are drive/simulation.ts.
 *
 * Real requests are budgeted: at most one Directions request per 5 real
 * seconds whatever the speed, and at most `maxRequests` per drive. The
 * simulated clock stands still while a poll is out, so the answer is always
 * for the place the car is at. Signal data for the fresh routes comes through
 * driveSignalSources: never with retryFailed, and a tile outside the bundle
 * is asked for at most once.
 */
export function useDriveSim(token: string | null, destination: LngLat, startRoute: RouteCandidate | null): DriveSim {
  const [status, setStatus] = useState<DriveStatus>('idle')
  const [view, setView] = useState<DriveView | null>(null)
  const [multiplier, setMultiplier] = useState<SpeedMultiplier>(5)
  const [settings, setSettings] = useState<DriveSettings>(DEFAULT_DRIVE_SETTINGS)
  const [rerouteOptions, setRerouteOptions] = useState<RerouteOptions>(DEFAULT_REROUTE_OPTIONS)
  const [whatIfDelaySec, setWhatIfDelaySec] = useState(0)

  const runRef = useRef<Run | null>(null)
  // What the timer and a poll in flight should see, without restarting either.
  const latest = useRef({ token, destination, startRoute, multiplier, settings, rerouteOptions, whatIfDelaySec })
  useEffect(() => {
    latest.current = { token, destination, startRoute, multiplier, settings, rerouteOptions, whatIfDelaySec }
  })

  const poll = useCallback(async (run: Run) => {
    const { token, destination, whatIfDelaySec: delaySec, settings, rerouteOptions } = latest.current
    const here = pointAtDistance(run.route.geometry, run.clock.alongM)
    if (token === null || here === null) return
    const controller = new AbortController()
    run.inFlight = controller
    run.clock = afterRequest(run.clock, performance.now())
    // One more request, for the current path's own travel time, only with room for it in the budget.
    const roomForBaseline = run.clock.requestsUsed < settings.maxRequests
    // Side-street probes share the same budget, and never take the baseline's room.
    let probesSent = 0
    const probesAllowed = checkProbeAllowance({ requestsUsed: run.clock.requestsUsed, probesUsed: run.probes.used }, settings.maxRequests)
    const result = await fetchFreshRoutes({
      token,
      origin: here.point,
      destination,
      headingDeg: here.bearingDeg,
      signal: controller.signal,
      whatIf: { route: run.route, alongM: run.clock.alongM, delaySec },
      baseline: roomForBaseline ? { route: run.route, alongM: run.clock.alongM, rerouteOptions } : null,
      probes: probesAllowed > 0 ? { route: run.route, alongM: run.clock.alongM, allowed: probesAllowed, memory: run.probes, rerouteOptions } : null,
      // Every request is counted as it goes out, so a check that is stopped still counts what it made.
      onRequest: (probe) => {
        run.clock = { ...run.clock, requestsUsed: run.clock.requestsUsed + 1 }
        if (probe) {
          probesSent++
          run.probes = { ...run.probes, used: run.probes.used + 1 }
        }
      },
    })
    // Stopped, or replaced by a new drive, while the request was out. (The clock waits
    // for the signal counts too: the engine must be asked about the place the routes
    // were fetched from, not one further on.)
    if (runRef.current !== run) return
    if (!result.ok && result.aborted) {
      run.inFlight = null
      return
    }
    const fresh = result.ok ? result.fresh : null
    const candidates = result.ok ? result.candidates : null
    const signalsById: ReadonlyMap<string, readonly RouteSignal[]> = result.ok ? result.signalsByRouteId : new Map()
    run.inFlight = null
    const simulated = result.ok && result.simulated
    const decision = decideReroute(
      run.engine,
      {
        nowSec: run.clock.simTimeSec,
        route: run.route,
        positionAlongM: run.clock.alongM,
        speedMps: run.speedMps,
        candidates,
        baseline: result.ok ? result.baseline : null,
      },
      latest.current.rerouteOptions,
    )
    run.engine = decision.nextState
    run.probes = rememberCheckProbes(run.probes, result.ok ? result.probeRequests : 0, decision, candidates, probesSent, {
      route: run.route,
      alongM: run.clock.alongM,
      baseline: result.ok ? result.baseline : null,
      rerouteOptions: latest.current.rerouteOptions,
    })
    const viaSideStreets = decision.action === 'switch' && fresh?.find((c) => c.id === decision.toRouteId)?.source === 'probe'
    const reason = viaSideStreets ? `${decision.reason} (via side streets)` : decision.reason
    const said = result.ok ? reason : `${reason} (${result.message})`
    addLog(run, decision.action, simulated ? `${said} [what-if: +${formatDuration(delaySec)} simulated delay]` : said, simulated)

    if (candidates !== null && fresh !== null) {
      run.candidates = candidates
      const chosen = decision.action === 'switch' ? fresh.find((c) => c.id === decision.toRouteId) : undefined
      if (chosen !== undefined) {
        run.route = chosen
        run.routeLengthM = alongRouteM(chosen.geometry).at(-1) ?? 0
        run.speedMps = cruiseSpeedMps(chosen)
        run.clock = afterSwitch(run.clock)
        run.currentCandidateId = chosen.id
        if (simulated) {
          // The delay was on the route just left; the new one starts clean.
          setWhatIfDelaySec(0)
          addLog(run, 'note', 'What-if delay cleared: it applied to the route just left.')
        }
      } else {
        const current = findCurrentRoute(run.route, run.clock.alongM, fresh, latest.current.rerouteOptions)
        run.currentCandidateId = current?.id ?? null
        if (current !== null) run.speedMps = cruiseSpeedMps(current)
      }
      run.signals = (run.currentCandidateId !== null && signalsById.get(run.currentCandidateId)) || NO_SIGNALS
      const pending = decision.code === 'confirming' || decision.code === 'cooldown'
      run.turn =
        decision.considered !== null && (pending || decision.action === 'switch')
          ? { at: decision.considered.turnAt, pending }
          : null
    }
    setView(viewOf(run))
  }, [])

  useEffect(() => {
    if (status !== 'running') return
    let last = performance.now()
    const timer = setInterval(() => {
      const run = runRef.current
      if (run === null) return
      const now = performance.now()
      const dt = now - last
      last = now
      // The clock waits for a poll that is out.
      if (run.inFlight !== null) return
      run.clock = advance(run.clock, dt, latest.current.multiplier, run.speedMps, run.routeLengthM)
      if (run.clock.alongM >= run.routeLengthM) {
        addLog(run, 'note', `Arrived after ${formatDuration(run.clock.simTimeSec)} of simulated driving.`)
        run.turn = null
        setView(viewOf(run))
        setStatus('arrived')
        return
      }
      const gate = pollGate(run.clock, now, latest.current.settings)
      if (gate === 'due') void poll(run)
      else if (gate === 'budget-spent' && !run.budgetNoted) {
        run.budgetNoted = true
        addLog(run, 'note', `Request budget used up (${latest.current.settings.maxRequests}): driving on without checking for faster routes.`)
      }
      setView(viewOf(run))
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [status, poll])

  const stop = useCallback(() => {
    runRef.current?.inFlight?.abort()
    runRef.current = null
    setView(null)
    setStatus('idle')
  }, [])

  const start = useCallback(() => {
    const { token, startRoute, settings } = latest.current
    if (token === null || startRoute === null) return
    runRef.current?.inFlight?.abort()
    const run: Run = {
      route: startRoute,
      routeLengthM: alongRouteM(startRoute.geometry).at(-1) ?? 0,
      speedMps: cruiseSpeedMps(startRoute),
      clock: DRIVE_START,
      engine: INITIAL_REROUTE_STATE,
      probes: INITIAL_CHECK_PROBES,
      inFlight: null,
      candidates: null,
      currentCandidateId: null,
      signals: NO_SIGNALS,
      turn: null,
      log: [],
      budgetNoted: false,
    }
    addLog(
      run,
      'note',
      `Drive started: ${formatDuration(startRoute.durationSec)}, ${formatDistance(startRoute.distanceM)}. Checking for faster routes every ${settings.pollIntervalSec} s of simulated time, at most one request per ${MIN_REQUEST_GAP_MS / 1000} s.`,
    )
    runRef.current = run
    setView(viewOf(run))
    setStatus('running')
  }, [])

  const pause = useCallback(() => setStatus((s) => (s === 'running' ? 'paused' : s)), [])
  const resume = useCallback(() => setStatus((s) => (s === 'paused' ? 'running' : s)), [])

  // A drive does not outlive the page it was started on.
  useEffect(() => () => runRef.current?.inFlight?.abort(), [])

  return {
    status,
    view,
    multiplier,
    setMultiplier,
    settings,
    setSettings,
    rerouteOptions,
    setRerouteOptions,
    whatIfDelaySec,
    setWhatIfDelaySec,
    canStart: token !== null && startRoute !== null,
    start,
    pause,
    resume,
    stop,
  }
}
