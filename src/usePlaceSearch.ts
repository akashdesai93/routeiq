import { useCallback, useEffect, useRef, useState } from 'react'
import { sessionForSuggest, type LngLat, type PlaceSuggestion, type SearchSession } from './core/index.ts'
import type { RetrieveResult } from './providers/mapbox/searchAdapter.ts'
import { fetchPlace, fetchSuggestions } from './providers/mapbox/searchClient.ts'
import { createSearchRunner, IDLE_SEARCH, type SearchRunner, type SearchState } from './search/searchRunner.ts'

export interface PlaceSearch {
  state: SearchState
  /** True while a picked suggestion is being looked up. */
  retrieving: boolean
  /** Call with the field's whole text on every change. */
  setText: (text: string) => void
  /** Looks a picked suggestion up. Null when another pick replaced this one. */
  choose: (suggestion: PlaceSuggestion) => Promise<RetrieveResult | null>
  /** Stops any suggestion request and goes back to idle. A pick already under way carries on. */
  reset: () => void
}

function newSessionToken(): string {
  // UUIDv4, as Mapbox recommends. Random, and tied to nothing about the user or the device.
  return crypto.randomUUID()
}

/**
 * Search for one field: suggestions as the user types (debounced, three
 * characters or more, each keystroke aborting the request before it) and the
 * lookup of the one that is picked. Orchestrates only. The suggest requests
 * and the retrieve that follows share one session token, which Mapbox bills
 * as one session; a pick ends the session.
 *
 * `getProximity` is asked at request time for the point to bias results to
 * (the centre of the map).
 */
export function usePlaceSearch(token: string, getProximity: () => LngLat): PlaceSearch {
  const [state, setState] = useState<SearchState>(IDLE_SEARCH)
  const [retrieving, setRetrieving] = useState(false)
  const session = useRef<SearchSession | null>(null)
  const runner = useRef<SearchRunner | null>(null)
  const picking = useRef<AbortController | null>(null)
  const inputs = useRef({ token, getProximity })

  useEffect(() => {
    inputs.current = { token, getProximity }
  })

  useEffect(() => {
    const made = createSearchRunner({
      onState: setState,
      search: (query, signal) => {
        session.current = sessionForSuggest(session.current, Date.now(), newSessionToken)
        return fetchSuggestions({
          query,
          token: inputs.current.token,
          sessionToken: session.current.token,
          proximity: inputs.current.getProximity(),
          signal,
        })
      },
    })
    runner.current = made
    return () => {
      made.cancel()
      runner.current = null
      picking.current?.abort()
    }
  }, [])

  const setText = useCallback((text: string) => runner.current?.input(text), [])
  const reset = useCallback(() => runner.current?.cancel(), [])

  const choose = useCallback(async (suggestion: PlaceSuggestion): Promise<RetrieveResult | null> => {
    runner.current?.cancel()
    picking.current?.abort()
    const controller = new AbortController()
    picking.current = controller
    // A suggestion can only have come from a session; the fallback covers a list shown after one idled out.
    const sessionToken = session.current?.token ?? newSessionToken()
    setRetrieving(true)
    const result = await fetchPlace({
      id: suggestion.id,
      token: inputs.current.token,
      sessionToken,
      signal: controller.signal,
    })
    if (picking.current !== controller) return null
    picking.current = null
    setRetrieving(false)
    if (controller.signal.aborted) return null
    // The retrieve closed the session on Mapbox's side, whether it worked or not.
    session.current = null
    return result
  }, [])

  return { state, retrieving, setText, choose, reset }
}
