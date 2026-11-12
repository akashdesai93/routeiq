import { isValidLngLat, SEARCH_RESULT_LIMIT, searchQuery, type LngLat } from '../../core/index.ts'
import { mapboxGet, redactToken, type MapboxFailure } from './http.ts'
import {
  parseRetrieved,
  parseSuggestions,
  type RetrieveResult,
  type SearchFailure,
  type SuggestResult,
} from './searchAdapter.ts'

const SEARCH_BASE = 'https://api.mapbox.com/search/searchbox/v1'

/**
 * What a suggestion may be: places one can drive to. Leaving out `category`
 * and `brand` keeps "Coffee" style entries, which stand for many places, off
 * the list (the adapter drops any that still arrive).
 */
export const SEARCH_TYPES = 'poi,address,street,place,locality,neighborhood,postcode'

/** Mapbox allows 10 suggestions at most. */
const MAX_LIMIT = 10

/** Four decimals is about 10 m: plenty to bias a search, and it does not say exactly where the map is centred. */
function proximityOf([lng, lat]: LngLat): string {
  return `${Number(lng.toFixed(4))},${Number(lat.toFixed(4))}`
}

export interface SuggestUrlOptions {
  /** What was typed. Cleaned by core's searchQuery; too short gives no URL. */
  query: string
  token: string
  /** Groups the suggest requests and the retrieve that follows into one billed session. */
  sessionToken: string
  /**
   * Results near this point come first. Always sent: without it Mapbox
   * falls back on locating the caller by IP address.
   */
  proximity: LngLat
  limit?: number
}

/**
 * Search Box API `/suggest` URL. The typed text is percent-encoded by
 * URLSearchParams; `proximity` goes longitude,latitude as the Mapbox docs
 * ask. Null when the text is too short, the session token is empty or the
 * proximity is not a valid coordinate.
 */
export function buildSuggestUrl(options: SuggestUrlOptions): string | null {
  const { token, sessionToken, proximity, limit = SEARCH_RESULT_LIMIT } = options
  const q = searchQuery(options.query)
  if (q === null || sessionToken === '' || !isValidLngLat(proximity)) return null
  const query = new URLSearchParams({
    q,
    language: 'en',
    limit: String(Math.min(MAX_LIMIT, Math.max(1, Math.round(limit)))),
    types: SEARCH_TYPES,
    proximity: proximityOf(proximity),
    session_token: sessionToken,
    access_token: token,
  })
  return `${SEARCH_BASE}/suggest?${query.toString()}`
}

/**
 * Search Box API `/retrieve` URL for a picked suggestion, with the session
 * token of the suggest requests before it. Null when the id or the session
 * token is empty.
 */
export function buildRetrieveUrl(id: string, token: string, sessionToken: string): string | null {
  if (id.trim() === '' || sessionToken === '') return null
  const query = new URLSearchParams({ session_token: sessionToken, access_token: token })
  return `${SEARCH_BASE}/retrieve/${encodeURIComponent(id)}?${query.toString()}`
}

interface RequestOptions {
  token: string
  sessionToken: string
  /** Aborting resolves with kind 'aborted'; the caller should ignore that result. */
  signal?: AbortSignal
  /** Swapped out in tests so they never touch the network. */
  fetchImpl?: typeof fetch
}

export interface FetchSuggestionsOptions extends RequestOptions {
  query: string
  proximity: LngLat
  limit?: number
}

export interface FetchPlaceOptions extends RequestOptions {
  /** PlaceSuggestion.id of the suggestion that was picked. */
  id: string
}

type Outcome = { readonly status: number; readonly body: unknown } | MapboxFailure

/** One GET (see mapboxGet), worded for search. */
function request(url: string, { signal, fetchImpl = fetch }: RequestOptions): Promise<Outcome> {
  return mapboxGet(url, signal, fetchImpl, {
    aborted: 'Search cancelled.',
    network: 'Could not reach Mapbox search. Check your internet connection, or drag a pin instead.',
    rateLimit: 'Mapbox is rate limiting search requests (429). Wait a minute, then try again.',
  })
}

function settle<T extends SuggestResult | RetrieveResult>(outcome: Outcome, parse: (body: unknown) => T, token: string): T | SearchFailure {
  if ('ok' in outcome) return outcome
  const result = parse(outcome.body)
  if (outcome.status >= 200 && outcome.status < 300) return redactToken(result, token)
  // Non-2xx: keep Mapbox's own explanation when it sent one (400 Bad request).
  if (!result.ok && result.kind === 'api') return redactToken(result, token)
  return {
    ok: false,
    kind: 'api',
    message: `Mapbox search is not available right now (HTTP ${outcome.status}). Try again shortly.`,
  }
}

/**
 * Asks Mapbox for suggestions for the typed text. Never rejects: HTTP,
 * network and abort failures all come back as a typed result with a message
 * fit to show the user. Text too short to search answers with an empty list
 * and no request.
 */
export async function fetchSuggestions(options: FetchSuggestionsOptions): Promise<SuggestResult> {
  const { query, token, sessionToken, proximity, limit } = options
  if (searchQuery(query) === null) return { ok: true, suggestions: [] }
  const url = buildSuggestUrl({ query, token, sessionToken, proximity, limit })
  if (url === null) return { ok: false, kind: 'malformed', message: 'The search could not be sent. Try again.' }
  return settle(await request(url, options), (body) => parseSuggestions(body, limit), token)
}

/**
 * Asks Mapbox where a picked suggestion is. Never rejects. This is the
 * request that ends the billing session the suggestions belonged to.
 */
export async function fetchPlace(options: FetchPlaceOptions): Promise<RetrieveResult> {
  const url = buildRetrieveUrl(options.id, options.token, options.sessionToken)
  if (url === null) return { ok: false, kind: 'malformed', message: 'That result cannot be looked up. Pick another.' }
  return settle(await request(url, options), parseRetrieved, options.token)
}
