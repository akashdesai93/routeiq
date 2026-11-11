import {
  LIVE_IDLE,
  liveStep,
  type LiveEffect,
  type LiveEvent,
  type LiveOptions,
  type LiveState,
  type LngLat,
  type RequestPurpose,
  type RouteCandidate,
} from '../core/index.ts'
import type { PositionSource } from '../device/geolocation.ts'
import type { Speaker } from '../device/speech.ts'
import type { PageVisibility } from '../device/visibility.ts'
import type { ScreenWakeLock } from '../device/wakeLock.ts'

/**
 * Runs a live drive: feeds the pure state machine (core/live.ts) with what
 * the device reports and carries out the effects it answers with. No React
 * and no browser API of its own: everything it touches is handed in, so the
 * tests run it on a fake clock with a replayed drive, and a native shell can
 * run it with its own position source, voice and screen lock.
 *
 * Positions pass through in memory only; nothing here stores or logs them.
 */

/** What a route request came back with. `routes` null: it failed, and `message` says how. */
export interface RoutesAnswer {
  readonly routes: readonly RouteCandidate[] | null
  readonly message?: string
  /** What came back when the current path itself was asked for; left out or null when it was not, or failed. */
  readonly baseline?: readonly RouteCandidate[] | null
  /** How many requests the answer took, when not one. */
  readonly requests?: number
}

export interface RoutesQuery {
  readonly purpose: RequestPurpose
  readonly origin: LngLat
  readonly destination: LngLat
  readonly headingDeg: number | null
  /** The route being driven and where the car is on it (null for the first route): for the what-if delay. */
  readonly driving: { readonly route: RouteCandidate; readonly alongM: number } | null
  /** True when one more request may be spent on the current path's own travel time (see LiveEffect 'request-routes'). */
  readonly baseline: boolean
  readonly signal: AbortSignal
}

export interface LiveRunnerDeps {
  readonly source: PositionSource
  /** Asks the directions provider. Must not reject; an aborted request may answer anything (it is ignored). */
  readonly routes: (query: RoutesQuery) => Promise<RoutesAnswer>
  readonly speaker: Speaker
  readonly wakeLock: ScreenWakeLock
  readonly visibility: PageVisibility
  /** The session's clock, in milliseconds. Every event is stamped with it. */
  readonly now: () => number
  /** Calls `fn` every `ms` milliseconds; returns the function that stops it. */
  readonly every: (ms: number, fn: () => void) => () => void
  /** Read at every event, so settings changed during a drive apply from the next one. */
  readonly options: () => Partial<LiveOptions>
  /** Called with the new state after every event that changed it. */
  readonly onChange: (state: LiveState) => void
  /** Called when a route request goes out (true) and when it is over (false). The replay holds its clock meanwhile. */
  readonly onBusy?: (busy: boolean) => void
}

export interface LiveRunner {
  /**
   * The Start tap. Call it from inside the tap handler: the first words have to be spoken there.
   * `route`: the route picked on the plan screen, to be driven (see LiveState.picked).
   */
  start(destination: LngLat, route?: RouteCandidate | null): void
  end(): void
  keepPrevious(): void
  setMuted(muted: boolean): void
  /** For the screen lock's own "released" event. */
  wakeLockReleased(): void
  state(): LiveState
  /** Ends the drive and lets go of everything. */
  dispose(): void
}

/** How often the session is asked whether anything is due, in milliseconds. */
export const LIVE_TICK_MS = 1000

export function createLiveRunner(deps: LiveRunnerDeps): LiveRunner {
  let state: LiveState = LIVE_IDLE
  let stopWatching: (() => void) | null = null
  let stopTicking: (() => void) | null = null
  let stopVisibility: (() => void) | null = null
  let inFlight: AbortController | null = null
  // Events that arrive while one is being handled (a source that answers at once) wait their turn.
  const waiting: LiveEvent[] = []
  let handling = false

  const endRequest = () => {
    if (inFlight === null) return
    inFlight.abort()
    inFlight = null
    deps.onBusy?.(false)
  }

  const run = (effect: LiveEffect) => {
    switch (effect.type) {
      case 'watch-position': {
        stopWatching?.()
        stopTicking?.()
        stopVisibility?.()
        stopTicking = deps.every(LIVE_TICK_MS, () => dispatch({ type: 'tick', nowMs: deps.now() }))
        stopVisibility = deps.visibility.subscribe((hidden) => dispatch({ type: 'visibility', nowMs: deps.now(), hidden }))
        if (deps.visibility.isHidden()) dispatch({ type: 'visibility', nowMs: deps.now(), hidden: true })
        stopWatching = deps.source.start(
          (fix) => dispatch({ type: 'fix', nowMs: deps.now(), fix }),
          (kind) => dispatch({ type: 'position-error', nowMs: deps.now(), kind }),
        )
        return
      }
      case 'stop-watching': {
        stopWatching?.()
        stopTicking?.()
        stopVisibility?.()
        stopWatching = stopTicking = stopVisibility = null
        return
      }
      case 'acquire-wake-lock':
        void deps.wakeLock.acquire().then((result) => dispatch({ type: 'wake-lock', result }))
        return
      case 'release-wake-lock':
        void deps.wakeLock.release()
        return
      case 'cancel-request':
        endRequest()
        return
      case 'request-routes': {
        endRequest()
        const destination = state.destination
        if (destination === null) return
        const controller = new AbortController()
        inFlight = controller
        deps.onBusy?.(true)
        const { requestId, purpose, origin, headingDeg, baseline } = effect
        const driving =
          state.route !== null && state.request !== null ? { route: state.route, alongM: state.request.alongM } : null
        void deps
          .routes({ purpose, origin, destination, headingDeg, driving, baseline, signal: controller.signal })
          .catch((): RoutesAnswer => ({ routes: null, message: 'The route request failed.' }))
          .then((answer) => {
            if (inFlight !== controller || controller.signal.aborted) return
            inFlight = null
            deps.onBusy?.(false)
            dispatch({
              type: 'routes',
              nowMs: deps.now(),
              requestId,
              routes: answer.routes,
              message: answer.message,
              baseline: answer.baseline,
              requests: answer.requests,
            })
          })
        return
      }
      case 'speak':
        deps.speaker.say(effect.line)
        return
      case 'prime-speech':
        deps.speaker.prime(effect.text)
        return
      case 'stop-speaking':
        deps.speaker.stop()
        return
      case 'set-muted':
        deps.speaker.setMuted(effect.muted)
        return
      case 'follow-route':
        deps.source.follow?.(effect.geometry)
        return
    }
  }

  function dispatch(event: LiveEvent): void {
    waiting.push(event)
    if (handling) return
    handling = true
    try {
      for (let next = waiting.shift(); next !== undefined; next = waiting.shift()) {
        const before = state
        const step = liveStep(state, next, deps.options())
        state = step.state
        step.effects.forEach(run)
        if (state !== before) deps.onChange(state)
      }
    } finally {
      handling = false
    }
  }

  return {
    start: (destination, route = null) => dispatch({ type: 'start', nowMs: deps.now(), destination, route }),
    end: () => dispatch({ type: 'end' }),
    keepPrevious: () => dispatch({ type: 'keep-previous', nowMs: deps.now() }),
    setMuted: (muted) => dispatch({ type: 'mute', muted }),
    wakeLockReleased: () => dispatch({ type: 'wake-lock', result: 'released' }),
    state: () => state,
    dispose() {
      dispatch({ type: 'end' })
      // An idle session answers 'end' with nothing; make sure nothing is left running either way.
      endRequest()
      stopWatching?.()
      stopTicking?.()
      stopVisibility?.()
      stopWatching = stopTicking = stopVisibility = null
    },
  }
}
