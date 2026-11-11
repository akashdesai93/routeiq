import type { KeyValueStore } from '../../storage/kv.ts'
import { isOsmSignalTile, type OsmSignalTile } from './adapter.ts'
import type { BundleCoverage, BundleLayer } from './bundleLayer.ts'
import { OVERPASS_COOLDOWN_MS, OVERPASS_MAX_COOLDOWN_MS, type OverpassClient } from './client.ts'

/**
 * Somewhere signal tiles can come from: the device cache, or the network.
 * (The bundled tiles have a layer type of their own, BundleLayer, because
 * they also say which tiles they cover.)
 */
export interface TileLayer {
  /** The tile, or null when this layer does not have it. Never rejects. */
  get(tileId: string): Promise<OsmSignalTile | null>
}

/** A layer that can also keep tiles: the device cache. */
export interface TileStore extends TileLayer {
  /** Never rejects; a tile that cannot be stored is dropped. */
  put(tile: OsmSignalTile): Promise<void>
}

/** A cached tile older than this is still used, and refreshed in the background: about a month. */
export const TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface TileSourceOptions {
  /**
   * Tried first: tiles built from OpenStreetMap extracts and shipped with the
   * app. Authoritative for the tiles it covers in full. Null or left out for none.
   */
  bundle?: BundleLayer | null
  /** For tiles the bundle does not cover: tried before the network, and where tiles from the network are kept. */
  cache: TileStore
  /** For tiles the bundle does not cover: tried last, once per missing tile, and used to refresh stale cached tiles. */
  network: TileLayer
  /** The clock, in milliseconds. */
  now?: () => number
  ttlMs?: number
  /** Called when a background refresh has replaced a stale tile. */
  onRefresh?: (tile: OsmSignalTile) => void
  /** A tile that could not be loaded is not tried again for this long (30 s), doubling each time it fails again. */
  retryMs?: number
  /** The longest a failed tile is left alone (8 minutes). */
  maxRetryMs?: number
}

export interface LoadedTiles {
  /** The tiles that could be loaded, by id. Each is complete for its tile. */
  readonly tiles: ReadonlyMap<string, OsmSignalTile>
  /** The ids that no layer could supply this time. */
  readonly missing: readonly string[]
  /**
   * For some of the missing tiles, the part of the tile the bundle does have
   * (a tile on the edge of the bundled area, clipped at the boundary). Not
   * the whole tile: good for a lower bound, never for a full count.
   */
  readonly partial: ReadonlyMap<string, OsmSignalTile>
}

export interface LoadOptions {
  /** Try tiles again even if they failed a moment ago: for a retry the user asked for, never for a timer. */
  retryFailed?: boolean
}

export interface TileSource {
  /** Loads the given tiles. Never rejects; what cannot be loaded is listed as missing. */
  load: (tileIds: readonly string[], options?: LoadOptions) => Promise<LoadedTiles>
}

/**
 * Loads signal tiles through the chain bundle -> cache -> network.
 *
 * - A tile the bundle covers in full comes from the bundle and nowhere else.
 *   The bundle goes BEFORE the device cache on purpose: it is the
 *   authoritative copy for its area and is renewed by rebuilding it, so a
 *   copy of the same tile cached from the network before the bundle existed
 *   must not shadow it. Such a tile is never written to the cache (it is
 *   already on the device, in the app's own files), never refreshed tile by
 *   tile, and never asked of the network, even when its file cannot be read.
 * - Any other tile is taken from the cache, or else asked of the network
 *   once and written to the cache. A cached tile older than `ttlMs` is
 *   returned as it is and refreshed from the network in the background, once
 *   per session; a refresh that fails changes nothing.
 * - A tile no layer has is missing. That is remembered for the session: the
 *   tile is not tried again for `retryMs`, then twice that, up to
 *   `maxRetryMs`, so a route that is recounted every few seconds (rerouting)
 *   does not ask for it on every tick. `retryFailed` skips the wait (the
 *   network client's own pause after a busy answer still holds). A tile on
 *   the edge of the bundled area that the network cannot supply is still
 *   missing, but the bundle's clipped part of it is handed back as `partial`.
 * - Tiles that were loaded are kept in memory for the session, and loads of
 *   the same tile that overlap share the work.
 */
export function createTileSource(options: TileSourceOptions): TileSource {
  const {
    bundle = null,
    cache,
    network,
    now = Date.now,
    ttlMs = TILE_TTL_MS,
    onRefresh,
    retryMs = OVERPASS_COOLDOWN_MS,
    maxRetryMs = OVERPASS_MAX_COOLDOWN_MS,
  } = options
  const session = new Map<string, OsmSignalTile>()
  const clipped = new Map<string, OsmSignalTile>()
  const pending = new Map<string, Promise<OsmSignalTile | null>>()
  const refreshed = new Set<string>()
  const failed = new Map<string, { until: number; nextMs: number }>()

  /** Guards against a layer handing back another tile's data, or something that is not a tile. */
  const from = async (layer: TileLayer, tileId: string): Promise<OsmSignalTile | null> => {
    try {
      const tile: unknown = await layer.get(tileId)
      return isOsmSignalTile(tile) && tile.tileId === tileId ? tile : null
    } catch {
      return null
    }
  }
  const standing = async (tileId: string): Promise<BundleCoverage> => {
    if (bundle === null) return 'none'
    try {
      return await bundle.coverage(tileId)
    } catch {
      return 'none'
    }
  }
  const keep = async (tile: OsmSignalTile) => {
    session.set(tile.tileId, tile)
    try {
      await cache.put(tile)
    } catch {
      // Not cached; it is fetched again another day.
    }
  }

  const refresh = (tileId: string) => {
    if (refreshed.has(tileId)) return
    refreshed.add(tileId)
    void from(network, tileId).then(async (fresh) => {
      if (fresh === null) return
      await keep(fresh)
      onRefresh?.(fresh)
    })
  }

  const loadOne = async (tileId: string): Promise<OsmSignalTile | null> => {
    const inBundle = await standing(tileId)
    if (bundle !== null && inBundle === 'covered') {
      const bundled = await from(bundle, tileId)
      if (bundled !== null) session.set(tileId, bundled)
      return bundled
    }
    const stored = await from(cache, tileId)
    if (stored !== null) {
      session.set(tileId, stored)
      if (now() - stored.fetchedAt > ttlMs) refresh(tileId)
      return stored
    }
    const fetched = await from(network, tileId)
    if (fetched !== null) {
      await keep(fetched)
      return fetched
    }
    if (bundle !== null && inBundle === 'clipped' && !clipped.has(tileId)) {
      const part = await from(bundle, tileId)
      if (part !== null) clipped.set(tileId, part)
    }
    return null
  }

  const one = (tileId: string, retryFailed: boolean): Promise<OsmSignalTile | null> => {
    const known = session.get(tileId)
    if (known !== undefined) return Promise.resolve(known)
    let loading = pending.get(tileId)
    if (loading !== undefined) return loading
    const failure = failed.get(tileId)
    if (failure !== undefined && !retryFailed && now() < failure.until) return Promise.resolve(null)
    loading = loadOne(tileId)
      .then((tile) => {
        if (tile !== null) failed.delete(tileId)
        else {
          const waitMs = failure?.nextMs ?? retryMs
          failed.set(tileId, { until: now() + waitMs, nextMs: Math.min(waitMs * 2, maxRetryMs) })
        }
        return tile
      })
      .finally(() => pending.delete(tileId))
    pending.set(tileId, loading)
    return loading
  }

  return {
    async load(tileIds, { retryFailed = false } = {}) {
      const ids = [...new Set(tileIds)]
      const loaded = await Promise.all(ids.map((id) => one(id, retryFailed)))
      const tiles = new Map<string, OsmSignalTile>()
      const partial = new Map<string, OsmSignalTile>()
      const missing: string[] = []
      ids.forEach((id, i) => {
        const tile = loaded[i]
        if (tile) {
          tiles.set(id, tile)
          return
        }
        missing.push(id)
        const part = clipped.get(id)
        if (part !== undefined) partial.set(id, part)
      })
      return { tiles, missing, partial }
    },
  }
}

/** Tiles held in memory: the cache in tests. */
export function memoryTileStore(initial: readonly OsmSignalTile[] = []): TileStore {
  const tiles = new Map(initial.map((tile) => [tile.tileId, tile]))
  return {
    get: (tileId) => Promise.resolve(tiles.get(tileId) ?? null),
    put: (tile) => {
      tiles.set(tile.tileId, tile)
      return Promise.resolve()
    },
  }
}

/** A tile cache on top of a key-value store (IndexedDB in the browser), keyed by tile id. */
export function tileStoreFrom(store: KeyValueStore<OsmSignalTile>): TileStore {
  return {
    get: (tileId) => store.get(tileId),
    put: (tile) => store.put(tile.tileId, tile),
  }
}

/** The network layer: one Overpass request per tile, through the polite client. A failure is a miss. */
export function overpassLayer(client: OverpassClient): TileLayer {
  return {
    get: async (tileId) => {
      const result = await client.fetchTile(tileId)
      return result.ok ? result.tile : null
    },
  }
}
