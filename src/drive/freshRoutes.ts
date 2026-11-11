import { withSignalCounts, type LngLat, type RouteCandidate, type RouteSignal } from '../core/index.ts'
import { fetchDirections } from '../providers/mapbox/client.ts'
import { driveSignalSources, loadSignalData, type SignalSources } from '../signalData.ts'
import { withWhatIfDelay } from './simulation.ts'

/**
 * One check for fresh routes during a drive, simulated or live: the
 * Directions request from the car's position (with its heading), the signal
 * counts of the routes that come back, and the development what-if delay.
 * Shared by useDriveSim and the live drive so that both ask in the same way.
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
      /** True when a what-if delay is part of `candidates`. */
      readonly simulated: boolean
    }
  | { readonly ok: false; readonly aborted: boolean; readonly message: string }

/** Never rejects. An aborted request comes back as `aborted`, to be ignored. */
export async function fetchFreshRoutes(request: FreshRoutesRequest): Promise<FreshRoutes> {
  const { token, origin, destination, headingDeg, signal, whatIf = null, fetchImpl, signalSources = driveSignalSources } = request
  const result = await fetchDirections({
    origin,
    destination,
    token,
    originHeadingDeg: headingDeg ?? undefined,
    signal,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  })
  if (!result.ok) return { ok: false, aborted: result.kind === 'aborted', message: result.message }
  // A check never retries failed signal tiles: only the "Retry signals" button does.
  const loaded = await loadSignalData(result.routes, signalSources)
  if (signal?.aborted) return { ok: false, aborted: true, message: 'Route request cancelled.' }
  const counted = withSignalCounts(result.routes, loaded.data)
  const candidates = whatIf === null ? counted.routes : withWhatIfDelay(counted.routes, whatIf.route, whatIf.alongM, whatIf.delaySec)
  return {
    ok: true,
    fresh: counted.routes,
    candidates,
    signalsByRouteId: counted.signalsByRouteId,
    simulated: candidates !== counted.routes,
  }
}
