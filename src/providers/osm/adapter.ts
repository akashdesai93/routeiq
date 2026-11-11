import { isValidLngLat, tileBounds, type SignalPoint } from '../../core/index.ts'
import { isExcludedSignalSubtype } from './bundle.ts'

/**
 * OpenStreetMap traffic signals, by tile. OpenStreetMap data is licensed
 * under the Open Database License (ODbL), "© OpenStreetMap contributors".
 * These types and the stores that hold them are kept apart from every other
 * signal source; the sources only meet in memory when a route is counted.
 */

/** One OpenStreetMap node tagged highway=traffic_signals. */
export interface OsmSignalNode {
  /** The OpenStreetMap node id. */
  readonly id: number
  readonly lng: number
  readonly lat: number
}

/**
 * Every signal node in one 0.1 degree tile (see core/tiles.ts), and when it
 * dates from. This is the shape held in the device cache and the shape a
 * bundled tile file has (see bundle.ts), as JSON:
 *
 *   { "tileId": "-809_352", "fetchedAt": 1794355200000,
 *     "nodes": [{ "id": 123, "lng": -80.8431, "lat": 35.2271 }] }
 *
 * A tile with no signals is a tile with an empty `nodes` list.
 */
export interface OsmSignalTile {
  readonly tileId: string
  /**
   * How current the data is, in milliseconds since 1970: when it left the
   * Overpass server (Date.now()), or for a bundled tile the date of the
   * extract it was built from.
   */
  readonly fetchedAt: number
  readonly nodes: readonly OsmSignalNode[]
}

export type OsmErrorKind =
  /** The server is at capacity or rate limiting (HTTP 429, 502, 503, 504, a timeout remark, or no answer in time). Try later. */
  | 'busy'
  /** Any other HTTP error, such as 400 or 406. */
  | 'api'
  /** The body is not an Overpass JSON answer. */
  | 'malformed'
  /** Filled by the fetch client, never by the adapter. */
  | 'network'
  | 'aborted'

export interface OsmFailure {
  readonly ok: false
  readonly kind: OsmErrorKind
  /** Written for the user. */
  readonly message: string
}

export type OsmNodesResult = { readonly ok: true; readonly nodes: readonly OsmSignalNode[] } | OsmFailure

const MALFORMED_HELP = 'The OpenStreetMap signal data came back in a form RouteIQ could not read.'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * The Overpass QL query for one tile: every node tagged
 * highway=traffic_signals inside the tile's box, as JSON. The box, written
 * south,west,north,east in whole tenths of a degree, is the only thing in it
 * that varies: there is no place for a route, a pin or anything else about
 * the trip. Null for anything that is not a tile id.
 */
export function buildOverpassQuery(tileId: string): string | null {
  const bounds = tileBounds(tileId)
  if (bounds === null) return null
  const [west, south, east, north] = bounds.map((edge) => edge.toFixed(1))
  return `[out:json][timeout:25];node[highway=traffic_signals](${south},${west},${north},${east});out;`
}

/**
 * True for a node whose `traffic_signals=*` tag marks it as a kind of signal
 * RouteIQ does not count (a flasher, a fire-station signal, a mid-block
 * crossing...), by the same rule and list as bundled tiles (see bundle.ts).
 */
function hasExcludedSubtype(element: Record<string, unknown>): boolean {
  const tags = element.tags
  if (!isRecord(tags) || typeof tags.traffic_signals !== 'string') return false
  return isExcludedSignalSubtype(tags.traffic_signals)
}

function toNode(element: unknown): OsmSignalNode | null {
  if (!isRecord(element) || element.type !== 'node') return null
  if (hasExcludedSubtype(element)) return null
  const { id, lon: lng, lat } = element
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null
  if (typeof lng !== 'number' || typeof lat !== 'number' || !isValidLngLat([lng, lat])) return null
  return { id, lng, lat }
}

/**
 * Turns an Overpass API JSON answer into signal nodes. Pure, and never
 * throws. Elements that are not usable nodes are skipped; a node listed twice
 * is kept once. Nodes whose `traffic_signals=*` subtype is excluded (see
 * EXCLUDED_SIGNAL_SUBTYPES in bundle.ts) are left out, as in bundled tiles. Overpass reports a query that ran out of time or memory with
 * HTTP 200 and a `remark`, possibly next to a cut-off list of elements: that
 * is a failure, never a short tile.
 */
export function parseOverpassSignals(body: unknown): OsmNodesResult {
  if (!isRecord(body) || !Array.isArray(body.elements)) return { ok: false, kind: 'malformed', message: MALFORMED_HELP }
  if (typeof body.remark === 'string' && body.remark !== '') {
    return {
      ok: false,
      kind: 'busy',
      message: 'The OpenStreetMap signal server could not finish the request. Try again in a minute.',
    }
  }
  const byId = new Map<number, OsmSignalNode>()
  for (const element of body.elements as unknown[]) {
    const node = toNode(element)
    if (node !== null && !byId.has(node.id)) byId.set(node.id, node)
  }
  return { ok: true, nodes: [...byId.values()] }
}

/** True for a well-formed tile, such as one read back from the cache or from a bundled file. */
export function isOsmSignalTile(value: unknown): value is OsmSignalTile {
  if (!isRecord(value) || typeof value.tileId !== 'string' || tileBounds(value.tileId) === null) return false
  if (typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt)) return false
  if (!Array.isArray(value.nodes)) return false
  return (value.nodes as unknown[]).every(
    (node) =>
      isRecord(node) &&
      typeof node.id === 'number' &&
      typeof node.lng === 'number' &&
      typeof node.lat === 'number' &&
      isValidLngLat([node.lng, node.lat]),
  )
}

/**
 * The nodes of some tiles as the SignalPoints the route matching takes, each
 * node once however many tiles list it (a node on a tile edge is in both).
 * OpenStreetMap signal nodes carry no intersection name.
 */
export function osmSignalPoints(tiles: Iterable<OsmSignalTile>): SignalPoint[] {
  const byId = new Map<number, SignalPoint>()
  for (const tile of tiles) {
    for (const node of tile.nodes) {
      if (!byId.has(node.id)) byId.set(node.id, { id: `osm-${node.id}`, position: [node.lng, node.lat], name: null })
    }
  }
  return [...byId.values()]
}
