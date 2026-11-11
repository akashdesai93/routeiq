import {
  baselineProbe,
  checkProbes,
  DEFAULT_PROBE_OPTIONS,
  mergeCheckProbes,
  withSignalCounts,
  type CheckProbeMemory,
  type LngLat,
  type RerouteOptions,
  type RouteCandidate,
  type RouteSignal,
} from '../core/index.ts'
import { fetchDirections, fetchProbeRoute } from '../providers/mapbox/client.ts'
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
 * is added for that, and none to any other service.
 *
 * Side-street probes (PLAN step 11c): when the caller allows them (`probes`),
 * up to `allowed` more Directions requests go out once the fresh routes (and
 * that answer) are in, each from the car (with its heading) through one via
 * point core checkProbes picks, to the destination. A probed route that is a
 * new path joins the fresh routes, tagged source 'probe' with its via, and
 * the reroute engine judges it like any other. A probe that fails, or finds a
 * route already known, adds nothing. Mapbox sees the via points, as it sees
 * the car's position and the destination; nothing else.
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
  /**
   * The route being driven and where the car is on it, with leave for up to
   * `allowed` side-street probes (see LiveEffect 'request-routes'). Null, left
   * out, or `allowed` 0: none.
   */
  readonly probes?: {
    readonly route: Pick<RouteCandidate, 'geometry'>
    readonly alongM: number
    readonly allowed: number
    readonly memory: CheckProbeMemory
    readonly rerouteOptions?: Partial<RerouteOptions>
  } | null
  /** Swapped out in tests. */
  readonly fetchImpl?: typeof fetch
  readonly signalSources?: SignalSources
}

export type FreshRoutes =
  | {
      readonly ok: true
      /** The routes as Mapbox sent them, then any new probed routes, with signal counts. A switch drives one of these. */
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
      /** Directions requests made for this answer: 1, plus 1 for the baseline request, plus one per probe. */
      readonly requests: number
      /** How many of those were side-street probes. */
      readonly probeRequests: number
    }
  | { readonly ok: false; readonly aborted: boolean; readonly message: string }

/** Never rejects. An aborted request comes back as `aborted`, to be ignored. */
export async function fetchFreshRoutes(request: FreshRoutesRequest): Promise<FreshRoutes> {
  const { token, origin, destination, headingDeg, signal, whatIf = null, baseline = null, probes = null, fetchImpl, signalSources = driveSignalSources } = request
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
    // "No route through these points" is an answer; any other failure is not. That includes
    // NoSegment (a via point would not snap to a road): the via points are fixed places, so
    // it would come back every check and say nothing about the road ahead (#52).
    asked = own.ok ? own.routes : own.kind === 'no-route' ? [] : null
  }

  // Side streets Mapbox did not offer: one request per via point, from the car.
  let probed: RouteCandidate[] = []
  let probeRequests = 0
  if (probes !== null && probes.allowed > 0) {
    const vias = checkProbes({
      route: probes.route,
      alongM: probes.alongM,
      fresh: result.routes,
      baseline: asked,
      memory: probes.memory,
      allowed: probes.allowed,
      rerouteOptions: probes.rerouteOptions,
    })
    probeRequests = vias.length
    requests += vias.length
    const answers = await Promise.all(
      vias.map((via) =>
        fetchProbeRoute({
          origin,
          via,
          destination,
          token,
          viaRadiusM: DEFAULT_PROBE_OPTIONS.viaRadiusM,
          originHeadingDeg: headingDeg ?? undefined,
          signal,
          ...(fetchImpl === undefined ? {} : { fetchImpl }),
        }),
      ),
    )
    if (signal?.aborted) return { ok: false, aborted: true, message: 'Route request cancelled.' }
    probed = answers.flatMap((route, i) => (route === null ? [] : [{ ...route, via: vias[i]! }]))
  }
  const routes = mergeCheckProbes(result.routes, asked, probed)

  // A check never retries failed signal tiles: only the "Retry signals" button does.
  const loaded = await loadSignalData(routes, signalSources)
  if (signal?.aborted) return { ok: false, aborted: true, message: 'Route request cancelled.' }
  const counted = withSignalCounts(routes, loaded.data)
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
    probeRequests,
  }
}
