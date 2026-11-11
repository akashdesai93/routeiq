import { isValidLngLat, tileBounds, tileIdAt } from '../../core/index.ts'
import type { OsmSignalNode, OsmSignalTile } from './adapter.ts'

/**
 * Bundled tiles: OpenStreetMap signal tiles built ahead of time from regional
 * extracts (scripts/build-signal-tiles.mjs) and shipped with the app as
 * static files. They are the primary source of signal data: inside the area
 * they cover in full, no signal server is ever asked. This file is the pure
 * part, used by both sides: the build script that writes the files and the
 * bundle layer (bundleLayer.ts) that reads them.
 *
 * The data is © OpenStreetMap contributors, ODbL 1.0, like every other tile,
 * and the folder it is written to holds nothing from any other source.
 */

/** Where the bundled files are served from, under the site root. */
export const OSM_BUNDLE_PATH = 'seed/osm-signals'

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors'
export const OSM_LICENSE = 'ODbL 1.0, https://www.openstreetmap.org/copyright'

/**
 * `traffic_signals=*` values of nodes that are tagged highway=traffic_signals
 * but are not a signalized intersection a driver stops at in the ordinary
 * way. They are left out, to match how the City of Charlotte adapter keeps
 * only full traffic signals (no flashers, pedestrian beacons, mid-block
 * crossings or fire-station signals):
 * - blinker: a flashing beacon;
 * - emergency: lights that only stop traffic for a fire station or the like;
 * - ramp_meter: a meter on a freeway on-ramp;
 * - pedestrian_crossing, crossing, bicycle_crossing, crossing_on_demand:
 *   signals for a mid-block crossing, not an intersection;
 * - level_crossing, bridge, tram_priority, bus_priority: signals for a
 *   railway crossing, a movable bridge or transit priority.
 */
export const EXCLUDED_SIGNAL_SUBTYPES: ReadonlySet<string> = new Set([
  'blinker',
  'emergency',
  'ramp_meter',
  'pedestrian_crossing',
  'crossing',
  'bicycle_crossing',
  'crossing_on_demand',
  'level_crossing',
  'bridge',
  'tram_priority',
  'bus_priority',
])

export interface SignalTagVerdict {
  /** True for a node that counts as a signalized intersection (or one approach of one). */
  readonly keep: boolean
  /**
   * What the node is, for the build report: the `traffic_signals=*` value
   * (lower case), "unspecified" when there is none, "crossing_only" for a
   * pedestrian signal tagged highway=crossing + crossing=traffic_signals, or
   * "not_a_signal".
   */
  readonly kind: string
}

/**
 * Decides whether an OpenStreetMap node is a traffic signal RouteIQ counts.
 * The rule is the tag highway=traffic_signals, minus the subtypes listed in
 * EXCLUDED_SIGNAL_SUBTYPES. A pedestrian signal is tagged highway=crossing
 * with crossing=traffic_signals, which is not highway=traffic_signals, so the
 * first test already leaves it out. A `traffic_signals` value that lists
 * several kinds ("signal;emergency") is kept unless every kind is excluded.
 */
export function classifySignalTags(tags: Readonly<Record<string, string>>): SignalTagVerdict {
  if (tags.highway !== 'traffic_signals') {
    const crossingOnly = tags.highway === 'crossing' && tags.crossing === 'traffic_signals'
    return { keep: false, kind: crossingOnly ? 'crossing_only' : 'not_a_signal' }
  }
  const subtype = tags.traffic_signals?.trim().toLowerCase() ?? ''
  if (subtype === '') return { keep: true, kind: 'unspecified' }
  const kinds = subtype.split(';').map((kind) => kind.trim())
  return { keep: !kinds.every((kind) => EXCLUDED_SIGNAL_SUBTYPES.has(kind)), kind: subtype }
}

function xyOf(tileId: string): [number, number] {
  const [x, y] = tileId.split('_').map(Number)
  return [x!, y!]
}

/**
 * Groups signal nodes into tiles: one tile for every tile at least one node
 * falls in, and none for the rest (inside the covered area, a tile without a
 * file is known to be empty; see OsmBundleIndex). A node exactly on an edge
 * between two tiles is put in both, as two per-tile Overpass queries would
 * return it. A node given twice (the two extracts overlap a little along the
 * state line) is kept once. Tiles are sorted by id and nodes by node id, so
 * the same data always gives the same files.
 */
export function groupIntoTiles(nodes: readonly OsmSignalNode[], fetchedAt: number): OsmSignalTile[] {
  const byTile = new Map<string, Map<number, OsmSignalNode>>()
  // One step smaller than anything the tile arithmetic tells apart (see tiles.ts).
  const STEP = 1e-7
  for (const node of nodes) {
    if (!isValidLngLat([node.lng, node.lat]) || !Number.isSafeInteger(node.id)) continue
    const candidates = new Set([
      tileIdAt([node.lng, node.lat]),
      tileIdAt([node.lng - STEP, node.lat]),
      tileIdAt([node.lng, node.lat - STEP]),
      tileIdAt([node.lng - STEP, node.lat - STEP]),
    ])
    for (const id of candidates) {
      const bounds = tileBounds(id)
      if (bounds === null) continue
      const [west, south, east, north] = bounds
      if (node.lng < west || node.lng > east || node.lat < south || node.lat > north) continue
      let tile = byTile.get(id)
      if (tile === undefined) byTile.set(id, (tile = new Map()))
      tile.set(node.id, { id: node.id, lng: node.lng, lat: node.lat })
    }
  }
  return [...byTile.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([tileId, tile]) => ({ tileId, fetchedAt, nodes: [...tile.values()].sort((a, b) => a.id - b.id) }))
}

/**
 * A set of tiles written compactly, as runs along each row. The key is the
 * row (the y of the tile id: the south edge in tenths of a degree) and the
 * value is a flat list of inclusive runs of x: [x0, x1, x0, x1, ...], in
 * order, not touching. { "352": [-812, -805] } is the eight tiles -812_352
 * to -805_352. Two states are about 2,800 tiles in about 180 runs.
 */
export type TileRows = Readonly<Record<string, readonly number[]>>

export function encodeTileRows(tileIds: Iterable<string>): TileRows {
  const byRow = new Map<number, number[]>()
  for (const id of new Set(tileIds)) {
    if (tileBounds(id) === null) continue
    const [x, y] = xyOf(id)
    const row = byRow.get(y)
    if (row) row.push(x)
    else byRow.set(y, [x])
  }
  const rows: Record<string, number[]> = {}
  for (const y of [...byRow.keys()].sort((a, b) => a - b)) {
    const runs: number[] = []
    for (const x of byRow.get(y)!.sort((a, b) => a - b)) {
      if (runs.length > 0 && runs[runs.length - 1] === x - 1) runs[runs.length - 1] = x
      else runs.push(x, x)
    }
    rows[String(y)] = runs
  }
  return rows
}

/** True when the tile is in the set. */
export function tileRowsHas(rows: TileRows, tileId: string): boolean {
  if (tileBounds(tileId) === null) return false
  const [x, y] = xyOf(tileId)
  const runs = rows[String(y)]
  if (runs === undefined) return false
  for (let i = 0; i + 1 < runs.length; i += 2) {
    if (x >= runs[i]! && x <= runs[i + 1]!) return true
  }
  return false
}

/** Every tile in the set, sorted as encodeTileRows wrote them (row by row, west to east). */
export function decodeTileRows(rows: TileRows): string[] {
  const ids: string[] = []
  for (const [y, runs] of Object.entries(rows)) {
    for (let i = 0; i + 1 < runs.length; i += 2) {
      for (let x = runs[i]!; x <= runs[i + 1]!; x++) ids.push(`${x}_${y}`)
    }
  }
  return ids
}

function isTileRows(value: unknown): value is TileRows {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.entries(value).every(
    ([y, runs]) =>
      /^-?\d+$/.test(y) &&
      Array.isArray(runs) &&
      runs.length % 2 === 0 &&
      (runs as unknown[]).every((x) => Number.isInteger(x)) &&
      (runs as number[]).every((x, i) => i === 0 || (i % 2 === 1 ? x >= runs[i - 1] : x > runs[i - 1] + 1)),
  )
}

/** One regional extract the bundle was built from. */
export interface OsmExtractInfo {
  /** The extract's name, as its boundary file gives it: "north-carolina". */
  readonly name: string
  /** When its data was current (the extract's replication timestamp), in milliseconds since 1970. */
  readonly dataDate: number
}

/**
 * index.json of the bundle folder. The app reads it once and from then on
 * knows, without another request, what the bundle says about any tile:
 * - in `covered` and in `files`: read `<tileId>.json`, and that is the answer;
 * - in `covered` but not in `files`: known to hold no signals. No file, no
 *   request, no 404;
 * - not in `covered`: the bundle does not speak for the tile (it is outside
 *   the extracts, or on their outer edge where the data is clipped), and it
 *   is loaded from the network instead. If it is in `files` all the same, the
 *   file holds the part of the tile inside the boundary: a lower bound, used
 *   only when the network fails.
 */
export interface OsmBundleIndex {
  readonly version: 2
  /** Where the data came from, in words. */
  readonly source: string
  /** When the data was current: the oldest of the extracts' dates. Every bundled tile carries it as fetchedAt. */
  readonly dataDate: number
  readonly extracts: readonly OsmExtractInfo[]
  /** The tiles that lie entirely inside the extracts' boundaries. */
  readonly covered: TileRows
  /** The tiles there is a file for: those with at least one signal. */
  readonly files: TileRows
  /** Distinct signal nodes in all the files together. */
  readonly nodeCount: number
  readonly attribution: string
  readonly license: string
}

export function buildBundleIndex(
  tiles: readonly OsmSignalTile[],
  coveredTileIds: readonly string[],
  extracts: readonly OsmExtractInfo[],
): OsmBundleIndex {
  const nodeIds = new Set(tiles.flatMap((tile) => tile.nodes.map((node) => node.id)))
  return {
    version: 2,
    source: `OpenStreetMap, regional extracts by Geofabrik (${extracts.map((e) => e.name).join(', ')})`,
    dataDate: Math.min(...extracts.map((e) => e.dataDate)),
    extracts,
    covered: encodeTileRows(coveredTileIds),
    files: encodeTileRows(tiles.map((tile) => tile.tileId)),
    nodeCount: nodeIds.size,
    attribution: OSM_ATTRIBUTION,
    license: OSM_LICENSE,
  }
}

/** True for a well-formed index. Only `dataDate`, `covered` and `files` are relied on. */
export function isOsmBundleIndex(value: unknown): value is OsmBundleIndex {
  if (typeof value !== 'object' || value === null) return false
  const { version, dataDate, covered, files } = value as Record<string, unknown>
  if (version !== 2 || typeof dataDate !== 'number' || !Number.isFinite(dataDate)) return false
  return isTileRows(covered) && isTileRows(files)
}
