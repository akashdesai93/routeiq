import { signalTilesForRoute, type RouteCandidate, type SignalData } from './core/index.ts'
import { isOsmSignalTile, osmSignalPoints, type OsmSignalTile } from './providers/osm/adapter.ts'
import { osmBundleUrl } from './providers/osm/bundle.ts'
import { createBundleLayer } from './providers/osm/bundleLayer.ts'
import { createOverpassClient, isOverpassPause } from './providers/osm/client.ts'
import {
  createTileSource,
  overpassLayer,
  tileStoreFrom,
  type LoadedTiles,
  type LoadOptions,
  type TileSource,
} from './providers/osm/tileSource.ts'
import { deleteIndexedDb, indexedDbStore } from './storage/kv.ts'

/** Where signal data comes from. Swapped out in tests. */
export interface SignalSources {
  /** OpenStreetMap signals, by tile: the primary source everywhere. */
  tiles: TileSource
}

export interface LoadedSignalData {
  /** What withSignalCounts takes. The sources are still apart in it. */
  readonly data: SignalData
  /** Tiles the routes need that could not be loaded. Empty when every count will be full. */
  readonly missingTileIds: readonly string[]
  /**
   * How old the OpenStreetMap data behind the counts is: the date of the
   * oldest tile that was loaded, in milliseconds since 1970 (a bundled tile
   * carries the date of the extract it was built from). Null when no tile
   * was loaded.
   */
  readonly primaryDataDate: number | null
}

/**
 * Loads the signal data a set of routes needs: the OpenStreetMap tiles the
 * routes touch, and no others. Never rejects: a tile that cannot be loaded is
 * reported as missing.
 *
 * A missing tile the bundle has a clipped part of (see LoadedTiles.partial)
 * adds that part's signals to the primary points without being listed as a
 * loaded tile: the route stays partial, with a better lower bound.
 */
export async function loadSignalData(
  routes: readonly RouteCandidate[],
  sources: SignalSources,
  options: LoadOptions = {},
): Promise<LoadedSignalData> {
  const tileIds = [...new Set(routes.flatMap((route) => signalTilesForRoute(route.geometry)))].sort()
  const nothing: LoadedTiles = { tiles: new Map(), missing: tileIds, partial: new Map() }
  const loaded = await sources.tiles.load(tileIds, options).catch(() => nothing)
  const dates = [...loaded.tiles.values()].map((tile) => tile.fetchedAt)
  return {
    data: {
      primary: osmSignalPoints([...loaded.tiles.values(), ...loaded.partial.values()]),
      primaryTileIds: new Set(loaded.tiles.keys()),
    },
    missingTileIds: loaded.missing,
    primaryDataDate: dates.length > 0 ? Math.min(...dates) : null,
  }
}

/**
 * The sources the app uses. OpenStreetMap tiles go through the chain
 * bundled tiles served with the app (public/seed/osm-signals, built from
 * regional extracts: authoritative for the tiles they cover in full) ->
 * device cache (IndexedDB, in a database of its own) -> Overpass. Only a
 * tile the bundle does not cover in full ever reaches the last two.
 */
export const signalSources: SignalSources = {
  tiles: createTileSource({
    bundle: createBundleLayer({ baseUrl: osmBundleUrl(import.meta.env?.BASE_URL ?? '/') }),
    cache: tileStoreFrom(indexedDbStore('routeiq-osm-signals', 'tiles', isOsmSignalTile)),
    network: overpassLayer(
      createOverpassClient({ pauseStore: indexedDbStore('routeiq-overpass-pause', 'pause', isOverpassPause) }),
    ),
  }),
}

/**
 * The database the removed City of Charlotte signal list was kept in (#13).
 * Nothing reads it any more; forgetOldSignalData deletes it from the device.
 */
export const RETIRED_DATABASES: readonly string[] = ['routeiq-charlotte-signals']

/** Deletes the databases of data sources the app no longer uses. Called once when the app starts. Never rejects. */
export function forgetOldSignalData(factory?: IDBFactory | null): Promise<void> {
  return Promise.all(RETIRED_DATABASES.map((name) => deleteIndexedDb(name, factory))).then(() => undefined)
}

/**
 * The same sources for a drive that polls (PLAN step 6), where the same
 * tiles are asked for again every minute. A tile that could not be loaded
 * is never asked for again for as long as the returned sources are kept.
 * The tile source on its own retries a failed tile once its wait is over
 * (30 s, doubling to 8 minutes), which over a long drive is still a request
 * to Overpass every few minutes. Here a tile outside the bundle costs at most
 * one attempt; after that its routes simply stay partial.
 *
 * Tiles the bundle covers are not affected: they never reach the network.
 */
export function askOnce(sources: SignalSources): SignalSources {
  // Tiles given up on, each with the clipped part the bundle had of it (see LoadedTiles.partial), if any.
  const gaveUp = new Map<string, OsmSignalTile | null>()
  return {
    tiles: {
      async load(tileIds) {
        const ids = [...new Set(tileIds)]
        // Never retryFailed here: that is for a retry the user asked for.
        const loaded = await sources.tiles.load(ids.filter((id) => !gaveUp.has(id)))
        loaded.missing.forEach((id) => gaveUp.set(id, loaded.partial.get(id) ?? null))
        const missing = ids.filter((id) => !loaded.tiles.has(id))
        const partial = new Map<string, OsmSignalTile>()
        for (const id of missing) {
          const part = gaveUp.get(id)
          if (part) partial.set(id, part)
        }
        return { tiles: loaded.tiles, missing, partial }
      },
    },
  }
}

/**
 * The sources a simulated drive polls through: one instance for the whole
 * session, so "at most once" holds across drives, not only within one.
 */
export const driveSignalSources: SignalSources = askOnce(signalSources)
