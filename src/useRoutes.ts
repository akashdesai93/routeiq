import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_PROBE_BUDGET,
  DEFAULT_PROBE_OPTIONS,
  mergeProbeRoutes,
  planProbes,
  rankRoutes,
  resolveSelectedId,
  sideStreetNotice,
  withSignalCounts,
  type LngLat,
  type RankedRoute,
  type RouteCandidate,
  type RouteSignal,
} from './core/index.ts'
import type { DirectionsResult } from './providers/mapbox/adapter.ts'
import { fetchDirections, fetchProbeRoute } from './providers/mapbox/client.ts'
import { loadSignalData, signalSources, type LoadedSignalData } from './signalData.ts'

/**
 * Where the signal data for the routes on screen stands. Routes never wait
 * for it. 'partial' means it was loaded as far as it could be and some of it
 * is missing: the affected routes say so themselves (signalCoverage).
 */
export type SignalsStatus = 'loading' | 'ready' | 'partial'

export interface RoutesState {
  /**
   * In the provider's order, then any probed routes (source 'probe') as they
   * come back. signalCount and signalCoverage are filled once the signal data is in.
   */
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
  /** True when Mapbox refused the token (401 or 403): every route request will fail the same way. */
  tokenRejected: boolean
  select: (id: string) => void
  /**
   * Counts the selected route as picked, as a tap on it would: called when
   * the user's hand or focus is on the route list or Start drive, so a probe
   * that joins (and reorders the list) cannot move the selection under them.
   * Does nothing once something is picked.
   */
  keepSelection: () => void
  /**
   * One line for a polite live region when a side-street probe is the
   * recommended route ("Faster route found via side streets, saves N min.").
   * Null otherwise.
   */
  sideStreetNotice: string | null
  retry: () => void
  /** Signals on the selected route, in driving order, for the map. */
  selectedSignals: readonly RouteSignal[]
  signalsStatus: SignalsStatus
  /**
   * Routes whose signal count is still being worked out while the others
   * keep theirs: a probed route that just joined. Empty while signalsStatus
   * is 'loading' (then every route is).
   */
  countingRouteIds: ReadonlySet<string>
  /** User-readable note on what signal data is missing; null when none is. */
  signalsError: string | null
  retrySignals: () => void
  /** How old the OpenStreetMap signal data behind the counts is, in milliseconds since 1970. Null when unknown. */
  signalDataDate: number | null
}

const NO_ROUTES: readonly RouteCandidate[] = []
const NO_SIGNALS: readonly RouteSignal[] = []
const NO_IDS: ReadonlySet<string> = new Set()

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
  // The last load for other routes, same attempt: while a probed route's tiles load, it
  // still speaks for the routes it was loaded for (see useRoutes).
  const previous = loaded === null && settled !== null && settled.attempt === attempt ? settled : null
  return { loaded, previous, retry }
}

/**
 * Side-street probes for the main routes on screen (PLAN step 11b): the via
 * points planProbes picks, each asked for as origin → via → destination once
 * the main routes have stayed put for the budget's debounce. A new set of
 * main routes (a pin moved, a retry) cancels the wait and aborts the requests
 * in flight. A probe that fails is simply missing. Returns the probed routes
 * that came back, as they arrive; empty until then.
 */
function useProbeRoutes(token: string | null, routes: readonly RouteCandidate[]) {
  const [settled, setSettled] = useState<{
    routes: readonly RouteCandidate[]
    /** One slot per via point, in planProbes order; null until (or unless) its probe came back. */
    slots: readonly (RouteCandidate | null)[]
  } | null>(null)

  useEffect(() => {
    if (token === null || routes.length === 0) return
    const vias = planProbes(routes, DEFAULT_PROBE_BUDGET)
    if (vias.length === 0) return
    // The routes' own ends (Mapbox's snapped origin and destination), not the pins: the
    // probes then start and end where the routes they are compared with do.
    const origin = routes[0]!.geometry[0]!
    const destination = routes[0]!.geometry.at(-1)!
    const controller = new AbortController()
    const timer = setTimeout(() => {
      vias.forEach((via, i) => {
        const viaRadiusM = DEFAULT_PROBE_OPTIONS.viaRadiusM
        void fetchProbeRoute({ origin, via: via.position, destination, token, viaRadiusM, signal: controller.signal }).then((probe) => {
          if (controller.signal.aborted || probe === null) return
          // Kept in via order, not arrival order, so the same answers always merge the same way.
          setSettled((prev) => {
            const slots = prev?.routes === routes ? [...prev.slots] : vias.map(() => null)
            slots[i] = probe
            return { routes, slots }
          })
        })
      })
    }, DEFAULT_PROBE_BUDGET.debounceMs)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [token, routes])

  return useMemo(
    () =>
      settled !== null && settled.routes === routes
        ? settled.slots.filter((r): r is RouteCandidate => r !== null)
        : NO_ROUTES,
    [settled, routes],
  )
}

/**
 * Fetches routes whenever the origin or destination changes and aborts the
 * request it replaces. One fetch per change, no polling here (the simulated drive polls: useDriveSim.ts).
 * A null token means "do not fetch".
 *
 * Side-street probes (useProbeRoutes) join the routes once they come back,
 * tagged source 'probe', and are ranked with them by the same rules.
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
  const provided = result?.ok ? result.routes : NO_ROUTES
  // Probes go out after the main routes are on screen; the main routes never wait for them.
  const probed = useProbeRoutes(token, provided)
  // The same array while nothing new is added: a new one would load (and blank) the signal counts again.
  const fetched = useMemo(() => {
    const merged = mergeProbeRoutes(provided, probed)
    return merged.length === provided.length ? provided : merged
  }, [provided, probed])
  const signals = useSignalData(fetched)
  // When a probed route joins, the routes already counted keep their counts (and their
  // tie-break) while the new route's tiles load: only the new one shows as counting.
  const previous = signals.previous
  const carried = useMemo(() => {
    if (previous === null || previous.routes.length === 0) return null
    const ids = new Set(fetched.map((r) => r.id))
    return previous.routes.every((r) => ids.has(r.id)) ? previous : null
  }, [previous, fetched])
  const signalData = signals.loaded?.data ?? null
  const counted = useMemo(() => {
    if (signals.loaded !== null || carried === null) return withSignalCounts(fetched, signalData)
    const known = new Set(carried.routes.map((r) => r.id))
    const kept = withSignalCounts(fetched.filter((r) => known.has(r.id)), carried.loaded.data)
    const byId = new Map(kept.routes.map((r) => [r.id, r]))
    return { routes: fetched.map((r) => byId.get(r.id) ?? r), signalsByRouteId: kept.signalsByRouteId }
  }, [fetched, signalData, signals.loaded, carried])
  const countingRouteIds = useMemo(() => {
    if (signals.loaded !== null || carried === null) return NO_IDS
    const known = new Set(carried.routes.map((r) => r.id))
    return new Set(fetched.filter((r) => !known.has(r.id)).map((r) => r.id))
  }, [fetched, signals.loaded, carried])
  const shownData = signals.loaded ?? carried?.loaded ?? null
  const routes = counted.routes
  const ranked = useMemo(() => rankRoutes(routes), [routes])
  const selectedId = useMemo(() => resolveSelectedId(routes, picked), [routes, picked])

  const select = useCallback(
    (id: string) => setPicked(fetched.find((r) => r.id === id) ?? null),
    [fetched],
  )
  const selectedRoute = routes.find((r) => r.id === selectedId) ?? null
  const keepSelection = useCallback(() => {
    if (selectedRoute !== null) setPicked((p) => p ?? selectedRoute)
  }, [selectedRoute])
  const notice = useMemo(() => sideStreetNotice(ranked), [ranked])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  const missingSignalData = shownData !== null && shownData.missingTileIds.length > 0

  return {
    routes,
    ranked,
    selectedId,
    loading: token !== null && result === null,
    error: result !== null && !result.ok ? result.message : null,
    tokenRejected: result !== null && !result.ok && result.kind === 'token',
    select,
    keepSelection,
    sideStreetNotice: notice,
    retry,
    selectedSignals: (selectedId !== null && counted.signalsByRouteId.get(selectedId)) || NO_SIGNALS,
    signalsStatus: shownData === null ? 'loading' : missingSignalData ? 'partial' : 'ready',
    countingRouteIds,
    signalsError: missingSignalData ? PARTIAL_HELP : null,
    retrySignals: signals.retry,
    signalDataDate: shownData?.primaryDataDate ?? null,
  }
}
