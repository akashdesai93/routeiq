import { isOsmSignalTile, type OsmSignalTile } from './adapter.ts'
import { isOsmBundleIndex, tileRowsHas, type OsmBundleIndex } from './bundle.ts'

/**
 * How the bundle stands on one tile:
 * - 'covered': the tile lies entirely inside the bundled area. What the
 *   bundle has for it is the whole answer, an empty tile included.
 * - 'clipped': the bundle has a file for it, but the tile reaches outside the
 *   bundled area, so the file is only part of the tile.
 * - 'none': the bundle is known not to have the tile: its index was read and
 *   does not list it, or the server said there is no bundle at all.
 * - 'unknown': the index could not be read (a dropped request, a busy server,
 *   a dead zone), so nobody knows yet whether the tile is covered. Never the
 *   same as 'none': the tile may well be covered, so it must not be asked of
 *   anyone else. It is missing for now, and the index is read again later.
 */
export type BundleCoverage = 'covered' | 'clipped' | 'none' | 'unknown'

/** How long a failed read of the app's own bundled files is left alone. See DEFAULT_BUNDLE_RETRY. */
export interface BundleRetryOptions {
  /** The wait after a first failed read, in milliseconds. It doubles each time the read fails again. */
  retryMs: number
  /** The longest wait, in milliseconds. */
  maxRetryMs: number
}

/**
 * The waits after a failed read of a bundled file (the index, or a covered
 * tile's file): 5 seconds, doubling to a minute. Much shorter than the waits
 * for Overpass (30 s to 8 min), because these are small static files of the
 * app itself: asking again costs nobody anything, and on a drive a dead zone
 * is usually over within a minute or two.
 */
export const DEFAULT_BUNDLE_RETRY: BundleRetryOptions = {
  retryMs: 5_000,
  maxRetryMs: 60_000,
}

export interface BundleReadOptions {
  /** Read the index again even if it failed a moment ago: for a retry the user asked for, never for a timer. */
  retryFailed?: boolean
}

/** The bundled tiles, as the tile source sees them. Neither method ever rejects. */
export interface BundleLayer {
  coverage(tileId: string, options?: BundleReadOptions): Promise<BundleCoverage>
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
  /** The clock, in milliseconds. */
  now?: () => number
  /** The wait before an index that could not be read is looked for again. Default: DEFAULT_BUNDLE_RETRY. */
  retry?: Partial<BundleRetryOptions>
}

/**
 * What came of reading a static file: its JSON; 'absent' when the server
 * answered that there is no such file (404 or 410); 'failed' for anything
 * else (no answer, another status, a body that is not JSON).
 */
type FileRead = { readonly kind: 'json'; readonly body: unknown } | { readonly kind: 'absent' | 'failed' }

async function readJson(url: string, fetchImpl: typeof fetch): Promise<FileRead> {
  try {
    // A static file of this site: no cookies are needed, and nothing about the trip is in the address.
    const response = await fetchImpl(url, { credentials: 'omit' })
    if (response.status === 404 || response.status === 410) return { kind: 'absent' }
    if (!response.ok) return { kind: 'failed' }
    return { kind: 'json', body: (await response.json()) as unknown }
  } catch {
    return { kind: 'failed' }
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
 * no 404). A file that is not a well-formed tile with the right id reads as
 * missing.
 *
 * Until the index has been read, what the layer says depends on why:
 * - The server answered that there is no index (404 or 410): no bundle was
 *   built. Every tile is 'none', and the tile source may go on to the cache
 *   and the network.
 * - Anything else (no answer, a 5xx, a page that is not the index): coverage
 *   is 'unknown'. That is NOT "not covered": the tile source asks nobody
 *   else and leaves the tile missing (#72).
 * Either way the index is looked for again after `retry.retryMs`, doubling
 * up to `retry.maxRetryMs` while it stays unreadable; `retryFailed` skips the
 * wait. Reads that overlap share one request.
 *
 * Nothing leaves the device beyond the request for the static file itself,
 * to the same server the page came from.
 */
export function createBundleLayer(options: BundleLayerOptions): BundleLayer {
  const { baseUrl, fetchImpl = fetch, now = Date.now } = options
  const { retryMs, maxRetryMs } = { ...DEFAULT_BUNDLE_RETRY, ...options.retry }
  type NoIndex = 'absent' | 'unknown'
  let index: OsmBundleIndex | null = null
  let reading: Promise<OsmBundleIndex | NoIndex> | null = null
  /** The last read that found no index: what it found, and when to look again. */
  let last: { readonly answer: NoIndex; readonly until: number; readonly nextMs: number } | null = null

  const readIndex = (retryFailed = false): Promise<OsmBundleIndex | NoIndex> => {
    if (index !== null) return Promise.resolve(index)
    if (reading !== null) return reading
    if (last !== null && !retryFailed && now() < last.until) return Promise.resolve(last.answer)
    reading = readJson(`${baseUrl}/index.json`, fetchImpl).then((file) => {
      reading = null
      if (file.kind === 'json' && isOsmBundleIndex(file.body)) {
        index = file.body
        last = null
        return index
      }
      const waitMs = last?.nextMs ?? retryMs
      // Only the server saying "no such file" means there is no bundle. Everything else is not knowing.
      const answer: NoIndex = file.kind === 'absent' ? 'absent' : 'unknown'
      last = { answer, until: now() + waitMs, nextMs: Math.min(waitMs * 2, maxRetryMs) }
      return answer
    })
    return reading
  }

  return {
    async coverage(tileId, { retryFailed = false } = {}) {
      const bundle = await readIndex(retryFailed)
      if (bundle === 'unknown') return 'unknown'
      if (bundle === 'absent') return 'none'
      if (tileRowsHas(bundle.covered, tileId)) return 'covered'
      return tileRowsHas(bundle.files, tileId) ? 'clipped' : 'none'
    },
    async get(tileId) {
      const bundle = await readIndex()
      if (typeof bundle === 'string') return null
      if (!tileRowsHas(bundle.files, tileId)) {
        // Inside the covered area, no file means no signals: that is knowledge, not a gap.
        return tileRowsHas(bundle.covered, tileId) ? { tileId, fetchedAt: bundle.dataDate, nodes: [] } : null
      }
      const file = await readJson(`${baseUrl}/${tileId}.json`, fetchImpl)
      const tile = file.kind === 'json' ? file.body : null
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
