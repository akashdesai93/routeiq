import { baselineProbe, withSignalCounts, type LngLat, type RerouteOptions, type RouteCandidate, type RouteSignal } from '../core/index.ts'
import { fetchDirections } from '../providers/mapbox/client.ts'
import { driveSignalSources, loadSignalData, type SignalSources } from '../signalData.ts'
import { withWhatIfDelay } from './simulation.ts'

/**
 * One check for fresh routes during a drive, simulated or live: the
 * Directions request from the car's position (with its heading), the signal
 * counts of the routes that come back, and the development what-if delay.
 * Shared by useDriveSim and the live drive so that both ask in the same way.
 *
 * When the routes that come back do not include the route being driven, its
 * fresh travel time is unknown and nothing can be compared like for like. If
 * the caller allows it (`baseline`), ONE more Directions request is made for
 * the current path itself, through via points along it (core baselineProbe
 * says which), and the answer is handed on as `baseline`. No other request
 * is added, and none to any other service.
 *
 * Signal data comes through the drive's once-only sources (askOnce): bundled
 * tiles, never retryFailed, a tile outside the bundle asked for at most once.
 */

export interface FreshRoutesRequest {
  readonly token: string
  readonly origin: LngLat
  readonly destination: LngLat
  /** The car's heading, sent as `bearings`. Null or left out: none. */
  readonly headingDeg?: number | null
  readonly signal?: AbortSignal
  /** The what-if delay to put on the route being driven, when there is one (development only). */
  readonly whatIf?: { readonly route: Pick<RouteCandidate, 'geometry'>; readonly alongM: number; readonly delaySec: number } | null
  /**
   * The route being driven and where the car is on it, with leave to spend one
   * more request on that path's own travel time when the fresh routes lack it.
   * Null or left out: never asked.
   */
  readonly baseline?: {
    readonly route: Pick<RouteCandidate, 'geometry'>
    readonly alongM: number
    /** The engine's thresholds in use, so the path is matched here as the engine will match it. */
    readonly rerouteOptions?: Partial<RerouteOptions>
  } | null
  /** Swapped out in tests. */
  readonly fetchImpl?: typeof fetch
  readonly signalSources?: SignalSources
}

export type FreshRoutes =
  | {
      readonly ok: true
      /** The routes as Mapbox sent them, with signal counts. A switch drives one of these. */
      readonly fresh: readonly RouteCandidate[]
      /** The same with the what-if delay applied; the same array as `fresh` when there is none. */
      readonly candidates: readonly RouteCandidate[]
      readonly signalsByRouteId: ReadonlyMap<string, readonly RouteSignal[]>
      /** True when a what-if delay is part of `candidates` (or of `baseline`). */
      readonly simulated: boolean
      /**
       * What came back for the current path itself (what-if delay applied).
       * Null: not asked (it was among the fresh routes, or no leave), or that
       * request failed. An empty list: asked, and there is no route that way.
       */
      readonly baseline: readonly RouteCandidate[] | null
      /** Directions requests made for this answer: 1, or 2 with the baseline request. */
      readonly requests: number
    }
  | { readonly ok: false; readonly aborted: boolean; readonly message: string }

/** Never rejects. An aborted request comes back as `aborted`, to be ignored. */
export async function fetchFreshRoutes(request: FreshRoutesRequest): Promise<FreshRoutes> {
  const { token, origin, destination, headingDeg, signal, whatIf = null, baseline = null, fetchImpl, signalSources = driveSignalSources } = request
  const shared = { origin, destination, token, originHeadingDeg: headingDeg ?? undefined, signal, ...(fetchImpl === undefined ? {} : { fetchImpl }) }
  const result = await fetchDirections(shared)
  if (!result.ok) return { ok: false, aborted: result.kind === 'aborted', message: result.message }

  // The current route is not among them: ask for that path itself, once.
  let asked: readonly RouteCandidate[] | null = null
  let requests = 1
  const probe = baseline === null ? null : baselineProbe(baseline.route, baseline.alongM, result.routes, baseline.rerouteOptions)
  if (probe !== null) {
    requests = 2
    const own = await fetchDirections({ ...shared, via: probe.via })
    if (!own.ok && own.kind === 'aborted') return { ok: false, aborted: true, message: own.message }
    // "No route through these points" is an answer; any other failure is not.
    asked = own.ok ? own.routes : own.kind === 'no-route' || own.kind === 'no-segment' ? [] : null
  }

  // A check never retries failed signal tiles: only the "Retry signals" button does.
  const loaded = await loadSignalData(result.routes, signalSources)
  if (signal?.aborted) return { ok: false, aborted: true, message: 'Route request cancelled.' }
  const counted = withSignalCounts(result.routes, loaded.data)
  const delayed = (routes: readonly RouteCandidate[]) =>
    whatIf === null ? routes : withWhatIfDelay(routes, whatIf.route, whatIf.alongM, whatIf.delaySec, baseline?.rerouteOptions)
  const candidates = delayed(counted.routes)
  const baselineRoutes = asked === null ? null : delayed(asked)
  return {
    ok: true,
    fresh: counted.routes,
    candidates,
    signalsByRouteId: counted.signalsByRouteId,
    simulated: candidates !== counted.routes || baselineRoutes !== asked,
    baseline: baselineRoutes,
    requests,
  }
}
