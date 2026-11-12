import { SEARCH_DEBOUNCE_MS, searchQuery, type PlaceSuggestion } from '../core/index.ts'
import type { SuggestResult } from '../providers/mapbox/searchAdapter.ts'

/** Where a search field stands. `query` is the cleaned text the state is about. */
export type SearchState =
  /** Nothing typed, or too little to search. */
  | { readonly status: 'idle' }
  /** Typing has not paused long enough yet. No request is out. */
  | { readonly status: 'waiting'; readonly query: string }
  | { readonly status: 'searching'; readonly query: string }
  | { readonly status: 'done'; readonly query: string; readonly suggestions: readonly PlaceSuggestion[] }
  | { readonly status: 'error'; readonly query: string; readonly message: string }

export const IDLE_SEARCH: SearchState = { status: 'idle' }

export interface SearchRunnerOptions {
  /** Does the search. Must not reject; an aborted search may answer anything, it is ignored. */
  search: (query: string, signal: AbortSignal) => Promise<SuggestResult>
  /** Called with every change of state. */
  onState: (state: SearchState) => void
  /** The timer, swapped out in tests for one that is fired by hand. */
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface SearchRunner {
  /** Call with the field's whole text on every change. */
  input(text: string): void
  /** Drops the pending timer and aborts the request that is out. Back to idle. */
  cancel(): void
}

/**
 * The typing-to-request logic of a search field, free of React and of the
 * real clock: wait until typing has paused for SEARCH_DEBOUNCE_MS, search only text
 * worth searching (core's searchQuery: three characters or more), and let
 * each new keystroke abort the request before it, so an old answer can never
 * replace a newer one. Typing that only changes spacing does not search
 * again.
 */
export function createSearchRunner(options: SearchRunnerOptions): SearchRunner {
  const {
    search,
    onState,
    setTimer = (run, ms) => setTimeout(run, ms),
    clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options
  let timer: unknown = null
  let inFlight: AbortController | null = null
  /** The query the current state is about; null when idle. */
  let current: string | null = null

  const drop = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
    inFlight?.abort()
    inFlight = null
  }

  const run = (query: string) => {
    timer = null
    const controller = new AbortController()
    inFlight = controller
    onState({ status: 'searching', query })
    void search(query, controller.signal).then((result) => {
      if (controller.signal.aborted || inFlight !== controller) return
      inFlight = null
      if (result.ok) onState({ status: 'done', query, suggestions: result.suggestions })
      else if (result.kind !== 'aborted') onState({ status: 'error', query, message: result.message })
    })
  }

  return {
    input(text) {
      const query = searchQuery(text)
      if (query === current) return
      drop()
      current = query
      if (query === null) {
        onState(IDLE_SEARCH)
        return
      }
      onState({ status: 'waiting', query })
      timer = setTimer(() => run(query), SEARCH_DEBOUNCE_MS)
    },
    cancel() {
      drop()
      if (current !== null) onState(IDLE_SEARCH)
      current = null
    },
  }
}
