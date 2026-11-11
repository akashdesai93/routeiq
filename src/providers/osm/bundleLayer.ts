import { isOsmSignalTile, type OsmSignalTile } from './adapter.ts'
import { isOsmBundleIndex, tileRowsHas, type OsmBundleIndex } from './bundle.ts'

/**
 * How the bundle stands on one tile:
 * - 'covered': the tile lies entirely inside the bundled area. What the
 *   bundle has for it is the whole answer, an empty tile included.
 * - 'clipped': the bundle has a file for it, but the tile reaches outside the
 *   bundled area, so the file is only part of the tile.
 * - 'none': the bundle has nothing to say (or there is no bundle).
 */
export type BundleCoverage = 'covered' | 'clipped' | 'none'

/** The bundled tiles, as the tile source sees them. Neither method ever rejects. */
export interface BundleLayer {
  coverage(tileId: string): Promise<BundleCoverage>
  /**
   * The bundled data of a 'covered' or 'clipped' tile. A covered tile without
   * signals comes back empty, without a request. Null when the bundle has
   * nothing for the tile, or its file cannot be read.
   */
  get(tileId: string): Promise<OsmSignalTile | null>
}

export interface BundleLayerOptions {
  /** The folder the bundle is served from, without a trailing slash: "/seed/osm-signals". */
  baseUrl: string
  /** Swapped out in tests so they never touch the network. */
  fetchImpl?: typeof fetch
}

async function readJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  try {
    // A static file of this site: no cookies are needed, and nothing about the trip is in the address.
    const response = await fetchImpl(url, { credentials: 'omit' })
    if (!response.ok) return null
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

/**
 * The bundle layer of the tile chain: tiles built ahead of time (see
 * scripts/build-signal-tiles.mjs) and served by this site itself as static
 * files, `<baseUrl>/<tileId>.json`, next to an `index.json` that says which
 * tiles are covered and which have a file.
 *
 * The index is read once, on the first tile asked about, and only files it
 * lists are ever requested: a covered tile without signals is answered from
 * the index alone, and a tile outside the bundle costs no request here (and
 * no 404). Without an index (no bundle was built, or the site is offline and
 * the file is not cached) the layer covers nothing, and looks for the index
 * again the next time. A file that is not a well-formed tile with the right
 * id reads as missing.
 *
 * Nothing leaves the device beyond the request for the static file itself,
 * to the same server the page came from.
 */
export function createBundleLayer(options: BundleLayerOptions): BundleLayer {
  const { baseUrl, fetchImpl = fetch } = options
  let index: OsmBundleIndex | null = null
  let reading: Promise<OsmBundleIndex | null> | null = null

  const readIndex = (): Promise<OsmBundleIndex | null> => {
    if (index !== null) return Promise.resolve(index)
    reading ??= readJson(`${baseUrl}/index.json`, fetchImpl).then((body) => {
      reading = null
      index = isOsmBundleIndex(body) ? body : null
      return index
    })
    return reading
  }

  return {
    async coverage(tileId) {
      const bundle = await readIndex()
      if (bundle === null) return 'none'
      if (tileRowsHas(bundle.covered, tileId)) return 'covered'
      return tileRowsHas(bundle.files, tileId) ? 'clipped' : 'none'
    },
    async get(tileId) {
      const bundle = await readIndex()
      if (bundle === null) return null
      if (!tileRowsHas(bundle.files, tileId)) {
        // Inside the covered area, no file means no signals: that is knowledge, not a gap.
        return tileRowsHas(bundle.covered, tileId) ? { tileId, fetchedAt: bundle.dataDate, nodes: [] } : null
      }
      const tile = await readJson(`${baseUrl}/${tileId}.json`, fetchImpl)
      return isOsmSignalTile(tile) && tile.tileId === tileId ? tile : null
    },
  }
}

/**
 * A bundle held in memory, for tests and hand-made data: the given tiles,
 * with `coveredTileIds` as the covered area (by default, exactly the tiles
 * given). A covered tile that is not among the tiles is empty; a tile given
 * but not covered is 'clipped'.
 */
export function memoryBundleLayer(
  tiles: readonly OsmSignalTile[],
  coveredTileIds: readonly string[] = tiles.map((tile) => tile.tileId),
  dataDate = 0,
): BundleLayer {
  const byId = new Map(tiles.map((tile) => [tile.tileId, tile]))
  const covered = new Set(coveredTileIds)
  return {
    coverage: (tileId) => Promise.resolve(covered.has(tileId) ? 'covered' : byId.has(tileId) ? 'clipped' : 'none'),
    get: (tileId) =>
      Promise.resolve(byId.get(tileId) ?? (covered.has(tileId) ? { tileId, fetchedAt: dataDate, nodes: [] } : null)),
  }
}
