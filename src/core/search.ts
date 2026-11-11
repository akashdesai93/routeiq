/**
 * The pure parts of place search: what a suggestion is, when typed text is
 * worth a request, and how requests are grouped into the provider's billing
 * sessions. No timers and no network here: see src/search/searchRunner.ts
 * and src/providers/mapbox/searchClient.ts.
 */

/** Fewer characters than this never reach the search provider. */
export const MIN_SEARCH_CHARS = 3
/** The provider's own limit on the length of a query. */
export const MAX_SEARCH_CHARS = 256
/** How long typing has to pause before a request goes out. */
export const SEARCH_DEBOUNCE_MS = 350
/** A handful: what fits under a field on a phone without scrolling. */
export const SEARCH_RESULT_LIMIT = 5

/**
 * One line of a suggestion list, provider-neutral. It has no position: the
 * provider gives that only when the suggestion is picked (one more request).
 */
export interface PlaceSuggestion {
  /** The provider's id, used to look the place up when picked. */
  readonly id: string
  /** "Bank of America Stadium", "800 S Mint St". */
  readonly name: string
  /** Where it is, for the second line: an address or "Charlotte, North Carolina, United States". May be empty. */
  readonly detail: string
  /** The provider's feature type: "poi", "address", "street", "place"… */
  readonly kind: string
}

/**
 * The query to send for what was typed, or null when it is not worth a
 * request: surrounding space is dropped, inner space collapsed, and anything
 * under MIN_SEARCH_CHARS waits for more typing.
 */
export function searchQuery(text: string): string | null {
  const query = text.replace(/\s+/g, ' ').trim()
  if (query.length < MIN_SEARCH_CHARS) return null
  return query.slice(0, MAX_SEARCH_CHARS).trim()
}

/** Mapbox closes a session after this many suggest requests. */
export const SESSION_MAX_SUGGESTS = 50
/**
 * Mapbox closes a session 180 s after a suggest request that no retrieve
 * followed. A little under that, so a request is never sent on a token whose
 * session has just closed on the server.
 */
export const SESSION_IDLE_MS = 170_000

/** One billing session: a token and how much of the session it has used. */
export interface SearchSession {
  readonly token: string
  readonly suggests: number
  readonly lastUsedMs: number
}

/**
 * The session a suggest request made now belongs to, already counting that
 * request. The running session is kept while it is still open on the
 * provider's side; a new one starts (with a new token) when there is none,
 * when it has used all its suggest requests, or when it has sat idle too
 * long. Picking a suggestion ends the session: the caller then drops it.
 * The time and the token maker are passed in, so this stays pure.
 */
export function sessionForSuggest(
  session: SearchSession | null,
  nowMs: number,
  newToken: () => string,
): SearchSession {
  const open =
    session !== null &&
    session.suggests < SESSION_MAX_SUGGESTS &&
    nowMs - session.lastUsedMs < SESSION_IDLE_MS &&
    nowMs >= session.lastUsedMs
  if (!open) return { token: newToken(), suggests: 1, lastUsedMs: nowMs }
  return { token: session.token, suggests: session.suggests + 1, lastUsedMs: nowMs }
}
