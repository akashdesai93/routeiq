import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  rankRoutes,
  resolveSelectedId,
  withSignalCounts,
  type LngLat,
  type RankedRoute,
  type RouteCandidate,
  type RouteSignal,
} from './core/index.ts'
import type { DirectionsResult } from './providers/mapbox/adapter.ts'
import { fetchDirections } from './providers/mapbox/client.ts'
import { loadSignalData, signalSources, type LoadedSignalData } from './signalData.ts'

/**
 * Where the signal data for the routes on screen stands. Routes never wait
 * for it. 'partial' means it was loaded as far as it could be and some of it
 * is missing: the affected routes say so themselves (signalCoverage).
 */
export type SignalsStatus = 'loading' | 'ready' | 'partial'

export interface RoutesState {
  /** In the provider's order. signalCount and signalCoverage are filled once the signal data is in. */
  routes: readonly RouteCandidate[]
  /**
   * The same routes, best first, each with its reasons (see rankRoutes). The
   * order can change when signal counts arrive, since they break ETA ties.
   */
  ranked: readonly RankedRoute[]
  /** The user's pick while it lasts, otherwise the top-ranked route. */
  selectedId: string | null
  loading: boolean
  /** User-readable; null when there is nothing wrong. */
  error: string | null
  select: (id: string) => void
  retry: () => void
  /** Signals on the selected route, in driving order, for the map. */
  selectedSignals: readonly RouteSignal[]
  signalsStatus: SignalsStatus
  /** User-readable note on what signal data is missing; null when none is. */
  signalsError: string | null
  retrySignals: () => void
  /** How old the OpenStreetMap signal data behind the counts is, in milliseconds since 1970. Null when unknown. */
  signalDataDate: number | null
}

const NO_ROUTES: readonly RouteCandidate[] = []
const NO_SIGNALS: readonly RouteSignal[] = []

const PARTIAL_HELP =
  'Signal data for part of this trip could not be loaded. Counts marked partial are a lower bound.'

/**
 * The signal data for the routes on screen: the OpenStreetMap tiles they
 * touch (see loadSignalData), loaded again whenever the routes change or
 * retry is called. Tiles already loaded are answered from memory, the
 * bundled files or the device cache, so only a tile that is
 * still missing can cost a request, and a tile that failed a moment ago is
 * not asked for again until its wait is over (see createTileSource), unless
 * the user asked for the retry. Null while loading.
 */
function useSignalData(routes: readonly RouteCandidate[]) {
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<{
    routes: readonly RouteCandidate[]
    attempt: number
    loaded: LoadedSignalData
  } | null>(null)

  // The attempt the last load was made for: a load for a new attempt is one the user asked for.
  const loadedAttempt = useRef(0)

  useEffect(() => {
    if (routes.length === 0) return
    let current = true
    const retryFailed = attempt !== loadedAttempt.current
    loadedAttempt.current = attempt
    void loadSignalData(routes, signalSources, { retryFailed }).then((loaded) => {
      if (current) setSettled({ routes, attempt, loaded })
    })
    return () => {
      current = false
    }
  }, [routes, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  // Data loaded for other routes, or before a retry, does not speak for these.
  const loaded = settled !== null && settled.routes === routes && settled.attempt === attempt ? settled.loaded : null
  return { loaded, retry }
}

/**
 * Fetches routes whenever the origin or destination changes and aborts the
 * request it replaces. One fetch per change, no polling here (the simulated drive polls: useDriveSim.ts).
 * A null token means "do not fetch".
 *
 * Signal counts are added on top when the signal data arrives: routes show
 * first, and a failed signal download never touches them. The routes are
 * then ranked (core/rank.ts): the top one is selected until the user picks
 * another, and a pick survives refetches and the arrival of signal counts.
 */
export function useRoutes(token: string | null, origin: LngLat, destination: LngLat): RoutesState {
  const [oLng, oLat] = origin
  const [dLng, dLat] = destination
  const [attempt, setAttempt] = useState(0)
  // Names the request the current inputs call for. Results made for another
  // key are stale and ignored, so nothing has to be reset in an effect.
  const key = `${oLng},${oLat};${dLng},${dLat}#${attempt}`
  const [settled, setSettled] = useState<{ key: string; result: DirectionsResult } | null>(null)
  // The picked route itself, not just its id: a refetch that returns the same
  // path keeps it selected (see resolveSelectedId), and it simply stops
  // matching when the routes change.
  const [picked, setPicked] = useState<RouteCandidate | null>(null)

  useEffect(() => {
    if (token === null) return
    const controller = new AbortController()
    void fetchDirections({
      origin: [oLng, oLat],
      destination: [dLng, dLat],
      token,
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted || (!result.ok && result.kind === 'aborted')) return
      setSettled({ key, result })
    })
    return () => controller.abort()
  }, [token, oLng, oLat, dLng, dLat, key])

  const result = token !== null && settled?.key === key ? settled.result : null
  const fetched = result?.ok ? result.routes : NO_ROUTES
  const signals = useSignalData(fetched)
  const signalData = signals.loaded?.data ?? null
  const counted = useMemo(() => withSignalCounts(fetched, signalData), [fetched, signalData])
  const routes = counted.routes
  const ranked = useMemo(() => rankRoutes(routes), [routes])
  const selectedId = useMemo(() => resolveSelectedId(routes, picked), [routes, picked])

  const select = useCallback(
    (id: string) => setPicked(fetched.find((r) => r.id === id) ?? null),
    [fetched],
  )
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  const missingSignalData = signals.loaded !== null && signals.loaded.missingTileIds.length > 0

  return {
    routes,
    ranked,
    selectedId,
    loading: token !== null && result === null,
    error: result !== null && !result.ok ? result.message : null,
    select,
    retry,
    selectedSignals: (selectedId !== null && counted.signalsByRouteId.get(selectedId)) || NO_SIGNALS,
    signalsStatus: signals.loaded === null ? 'loading' : missingSignalData ? 'partial' : 'ready',
    signalsError: missingSignalData ? PARTIAL_HELP : null,
    retrySignals: signals.retry,
    signalDataDate: signals.loaded?.primaryDataDate ?? null,
  }
}
