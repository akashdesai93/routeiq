import { isValidLngLat, SEARCH_RESULT_LIMIT, type LngLat, type Place, type PlaceSuggestion } from '../../core/index.ts'

export type SearchErrorKind =
  /** Mapbox answered with an error message of its own (a bad parameter, for example). */
  | 'api'
  /** The body is not a Search Box response. */
  | 'malformed'
  /** A picked suggestion came back without a usable place. */
  | 'not-found'
  /** Filled by the fetch client, never by the adapter. */
  | 'token'
  | 'rate-limit'
  | 'network'
  | 'aborted'

export interface SearchFailure {
  readonly ok: false
  readonly kind: SearchErrorKind
  /** Written for the user. Never contains the token or the typed text. */
  readonly message: string
}

/** An empty list is an answer ("nothing found"), not a failure. */
export type SuggestResult = { readonly ok: true; readonly suggestions: readonly PlaceSuggestion[] } | SearchFailure
export type RetrieveResult = { readonly ok: true; readonly place: Place } | SearchFailure

const MALFORMED_HELP = 'Mapbox sent a search response RouteIQ could not read. Try again.'
const NOT_FOUND_HELP = 'Mapbox could not give a location for that place. Pick another result.'

/**
 * Suggestion types that are not one place: a category ("Coffee") or a brand
 * stands for many, and picking it gives no single point to route to.
 */
const NOT_A_PLACE: ReadonlySet<string> = new Set(['category', 'brand'])

/** The id of a place that came from search: the provider's id, marked with where it came from. */
export const SEARCH_PLACE_ID_PREFIX = 'mapbox:'

function fail(kind: SearchErrorKind, message: string): SearchFailure {
  return { ok: false, kind, message }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Mapbox's own words for an error ({ message }), cut short; null when the body has none. */
function apiFailure(body: Record<string, unknown>): SearchFailure | null {
  const message = text(body.message)
  if (message === '') return null
  return fail('api', `Mapbox Search error: ${message.slice(0, 200)}`)
}

/** "800 S Mint St, Charlotte, North Carolina 28202, United States": the fullest description the suggestion carries. */
function detailOf(item: Record<string, unknown>): string {
  const fullAddress = text(item.full_address)
  if (fullAddress !== '') return fullAddress
  return [text(item.address), text(item.place_formatted)].filter((part) => part !== '').join(', ')
}

/**
 * Turns a Mapbox Search Box API `/suggest` JSON body into suggestions. Pure,
 * and never throws: anything unexpected comes back as a typed failure. A
 * suggestion without a name or an id, a category and a brand are left out,
 * as is a second suggestion with an id already listed; at most `limit` are
 * returned, in Mapbox's order. An empty list is a good answer.
 */
export function parseSuggestions(body: unknown, limit: number = SEARCH_RESULT_LIMIT): SuggestResult {
  if (!isRecord(body)) return fail('malformed', MALFORMED_HELP)
  if (!Array.isArray(body.suggestions)) return apiFailure(body) ?? fail('malformed', MALFORMED_HELP)
  const suggestions: PlaceSuggestion[] = []
  const seen = new Set<string>()
  for (const item of body.suggestions as unknown[]) {
    if (suggestions.length >= limit) break
    if (!isRecord(item)) continue
    const id = text(item.mapbox_id)
    const name = text(item.name)
    const kind = text(item.feature_type)
    if (id === '' || name === '' || NOT_A_PLACE.has(kind) || seen.has(id)) continue
    seen.add(id)
    suggestions.push({ id, name, detail: detailOf(item), kind })
  }
  return { ok: true, suggestions }
}

function toLngLat(lng: unknown, lat: unknown): LngLat | null {
  if (typeof lng !== 'number' || typeof lat !== 'number') return null
  const p: LngLat = [lng, lat]
  return isValidLngLat(p) ? p : null
}

/**
 * Where to route to. A large place (an airport, a mall, a stadium) has its
 * point in the middle of the site, which can be nearest to a road on the
 * wrong side; Mapbox lists `routable_points` on the road network for that,
 * and the first one is used when it is there. Otherwise the feature's own
 * point (GeoJSON order: longitude, latitude).
 */
function positionOf(feature: Record<string, unknown>, properties: Record<string, unknown>): LngLat | null {
  const coordinates = properties.coordinates
  if (isRecord(coordinates) && Array.isArray(coordinates.routable_points)) {
    for (const point of coordinates.routable_points as unknown[]) {
      const routable = isRecord(point) ? toLngLat(point.longitude, point.latitude) : null
      if (routable !== null) return routable
    }
  }
  const geometry = feature.geometry
  if (isRecord(geometry) && Array.isArray(geometry.coordinates)) {
    const at = toLngLat(geometry.coordinates[0], geometry.coordinates[1])
    if (at !== null) return at
  }
  return isRecord(coordinates) ? toLngLat(coordinates.longitude, coordinates.latitude) : null
}

/** A landmark goes by its name; anything else by its full address, without the country it ends in. */
function labelOf(properties: Record<string, unknown>): string {
  const name = text(properties.name)
  if (text(properties.feature_type) === 'poi' && name !== '') return name
  const full = text(properties.full_address) || [name, text(properties.place_formatted)].filter((p) => p !== '').join(', ')
  return full.replace(/, United States$/, '')
}

/**
 * Turns a Mapbox Search Box API `/retrieve` JSON body (a GeoJSON
 * FeatureCollection with one feature) into a Place. Pure, and never throws.
 */
export function parseRetrieved(body: unknown): RetrieveResult {
  if (!isRecord(body)) return fail('malformed', MALFORMED_HELP)
  if (!Array.isArray(body.features)) return apiFailure(body) ?? fail('malformed', MALFORMED_HELP)
  for (const feature of body.features as unknown[]) {
    if (!isRecord(feature) || !isRecord(feature.properties)) continue
    const position = positionOf(feature, feature.properties)
    const label = labelOf(feature.properties)
    const id = text(feature.properties.mapbox_id)
    if (position === null || label === '') continue
    return { ok: true, place: { id: `${SEARCH_PLACE_ID_PREFIX}${id === '' ? label : id}`, label, position } }
  }
  return fail('not-found', NOT_FOUND_HELP)
}
