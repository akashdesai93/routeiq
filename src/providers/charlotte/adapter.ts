import { isValidLngLat, type LngLat, type SignalPoint } from '../../core/index.ts'

export type SignalsErrorKind =
  /** The ArcGIS server answered with an error body ({ error: { code, message } }). */
  | 'api'
  /** The body is not a GeoJSON page of features, or the dataset came back empty. */
  | 'malformed'
  /** Filled by the fetch client, never by the adapter. */
  | 'network'
  | 'aborted'

export interface SignalsFailure {
  readonly ok: false
  readonly kind: SignalsErrorKind
  /** Written for the user. */
  readonly message: string
}

export type SignalsPageResult =
  | {
      readonly ok: true
      /** Operating traffic signals on this page; everything else is left out. */
      readonly signals: readonly SignalPoint[]
      /** How many features the page held before filtering, which is what paging advances by. */
      readonly featureCount: number
      /** True when the server says more records follow this page. */
      readonly more: boolean
    }
  | SignalsFailure

/** The attribute fields the adapter reads. The client asks the server for exactly these. */
export const SIGNAL_FIELDS = ['OBJECTID', 'UNITTYPE', 'SERVSTAT', 'UNITDESC'] as const

/**
 * UNITTYPE codes that are full traffic signals at an intersection: with loops
 * (TSL), with video detection (TSV) and fixed time (TS). The layer also holds
 * school flashers, stop-sign flashers, pedestrian beacons, mid-block crossings,
 * fire-station emergency signals and parking signs, none of which are
 * signalized intersections, so they are left out.
 */
const TRAFFIC_SIGNAL_TYPES: ReadonlySet<string> = new Set(['TSL', 'TSV', 'TS'])

/** SERVSTAT of a signal that is in service. "NOP" marks planned or removed ones. */
const OPERATING = 'OP'

const MALFORMED_HELP = 'The City of Charlotte signal data came back in a form RouteIQ could not read.'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function code(v: unknown): string {
  return typeof v === 'string' ? v.trim().toUpperCase() : ''
}

function toPosition(geometry: unknown): LngLat | null {
  if (!isRecord(geometry) || geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) return null
  const lng: unknown = geometry.coordinates[0]
  const lat: unknown = geometry.coordinates[1]
  if (typeof lng !== 'number' || typeof lat !== 'number') return null
  const p: LngLat = [lng, lat]
  return isValidLngLat(p) ? p : null
}

/** Null for anything that is not a usable, operating traffic signal. */
function toSignal(feature: unknown): SignalPoint | null {
  if (!isRecord(feature) || !isRecord(feature.properties)) return null
  const { OBJECTID, UNITTYPE, SERVSTAT, UNITDESC } = feature.properties
  if (typeof OBJECTID !== 'number' && typeof OBJECTID !== 'string') return null
  if (!TRAFFIC_SIGNAL_TYPES.has(code(UNITTYPE)) || code(SERVSTAT) !== OPERATING) return null
  const position = toPosition(feature.geometry)
  if (position === null) return null
  const name = typeof UNITDESC === 'string' && UNITDESC.trim() !== '' ? UNITDESC.trim() : null
  return { id: `clt-${OBJECTID}`, position, name }
}

/**
 * Turns one page of the City of Charlotte "Traffic Signals" layer, queried as
 * GeoJSON in WGS84 (f=geojson, outSR=4326), into SignalPoints. The layer has
 * one point per signalized intersection. Pure, and never throws: an ArcGIS
 * error body or anything unexpected comes back as a typed failure. Features
 * that are not operating traffic signals, or have no usable id or point, are
 * skipped rather than failing the page.
 */
export function parseSignalsPage(body: unknown): SignalsPageResult {
  if (!isRecord(body)) return { ok: false, kind: 'malformed', message: MALFORMED_HELP }
  // ArcGIS reports query errors in the body, usually with HTTP 200.
  if (isRecord(body.error)) {
    const { code: errorCode, message, details } = body.error
    // The message is often empty and the explanation sits in details[0].
    const firstDetail: unknown = Array.isArray(details) ? details[0] : undefined
    const text = typeof message === 'string' && message !== '' ? message : firstDetail
    const detail = typeof text === 'string' && text !== '' ? `: ${text}` : ''
    const status = typeof errorCode === 'number' ? ` ${errorCode}` : ''
    return {
      ok: false,
      kind: 'api',
      message: `The City of Charlotte signal service reported an error${status}${detail}`,
    }
  }
  if (body.type !== 'FeatureCollection' || !Array.isArray(body.features))
    return { ok: false, kind: 'malformed', message: MALFORMED_HELP }
  const features = body.features as unknown[]
  const more = isRecord(body.properties) && body.properties.exceededTransferLimit === true
  return {
    ok: true,
    signals: features.map(toSignal).filter((s): s is SignalPoint => s !== null),
    featureCount: features.length,
    more,
  }
}
