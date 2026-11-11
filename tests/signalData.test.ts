import { describe, expect, it } from 'vitest'
import {
  formatSignalCount,
  signalTilesForRoute,
  withSignalCounts,
  type LngLat,
  type RouteCandidate,
  type RouteIntersection,
  type SignalPoint,
} from '../src/core/index.ts'
import type { SignalsResult } from '../src/providers/charlotte/client.ts'
import type { OsmSignalTile } from '../src/providers/osm/adapter.ts'
import { createOverpassClient, OVERPASS_COOLDOWN_MS, OVERPASS_ENDPOINT } from '../src/providers/osm/client.ts'
import { memoryBundleLayer } from '../src/providers/osm/bundleLayer.ts'
import {
  createTileSource,
  memoryTileStore,
  overpassLayer,
  type TileStore,
} from '../src/providers/osm/tileSource.ts'
import { loadSignalData, type SignalSources } from '../src/signalData.ts'
import { fakeClock, fakeOverpass, settle, type TileAnswer } from './helpers/overpass.ts'

// The whole path a count takes, end to end, with the network replaced by a stand-in Overpass
// server: tiles a route touches -> bundle / cache / network -> core counting. No test here
// touches the network, and every position is made up for the test.

const DAY_MS = 24 * 60 * 60 * 1000

function route(id: string, geometry: readonly LngLat[], intersections: RouteIntersection[] | null = null): RouteCandidate {
  return {
    id,
    geometry,
    durationSec: 600,
    typicalDurationSec: null,
    distanceM: 1800,
    signalCount: null,
    signalCoverage: 'none',
    providerSignalCount: null,
    intersections,
    limitedAccessSpansM: null,
    maneuvers: [],
  }
}

/** A road running east along latitude 35.25, across the tile edge at longitude -80.8. */
const WEST = '-809_352'
const EAST = '-808_352'
const ROAD: LngLat[] = [
  [-80.81, 35.25],
  [-80.79, 35.25],
]
const crossing = route('crossing', ROAD)

const NO_CITY: SignalsResult = { ok: false, kind: 'network', message: 'offline' }
const city = (...signals: SignalPoint[]): SignalsResult => ({ ok: true, signals })

interface Setup {
  answers?: Record<string, TileAnswer>
  cached?: OsmSignalTile[]
  bundled?: OsmSignalTile[]
  city?: SignalsResult
  cache?: TileStore
  clock?: ReturnType<typeof fakeClock>
}

/** Sources wired the way the app wires them, on a stand-in server, a memory cache and a hand-moved clock. */
function setup(options: Setup = {}) {
  const clock = options.clock ?? fakeClock()
  const server = fakeOverpass(options.answers)
  const cache = options.cache ?? memoryTileStore(options.cached)
  const sources: SignalSources = {
    tiles: createTileSource({
      cache,
      bundle: options.bundled ? memoryBundleLayer(options.bundled) : null,
      network: overpassLayer(createOverpassClient({ fetchImpl: server.fetchImpl, now: clock.now })),
      now: clock.now,
    }),
    gapFill: { load: () => Promise.resolve(options.city ?? NO_CITY) },
  }
  return { clock, server, cache, sources }
}

/** Loads the data for the routes and counts them: what useRoutes does. */
async function count(routes: readonly RouteCandidate[], sources: SignalSources) {
  const loaded = await loadSignalData(routes, sources)
  const counted = withSignalCounts(routes, loaded.data)
  return {
    loaded,
    counted,
    results: counted.routes.map((r) => [r.signalCount, r.signalCoverage]),
    labels: counted.routes.map((r) => formatSignalCount(r.signalCount, r.signalCoverage)),
  }
}

describe('signal data, end to end', () => {
  it('loads the tiles of a route outside the bundled and cached area on demand', async () => {
    // The bundle covers one tile in the middle of Charlotte. This road is 160 km to the west.
    const bundled: OsmSignalTile[] = [{ tileId: WEST, fetchedAt: fakeClock().now(), nodes: [{ id: 1, lng: -80.85, lat: 35.25 }] }]
    const mountainRoad = route('mountain', [
      [-82.63, 35.55],
      [-82.57, 35.55],
    ])
    const { server, sources, cache } = setup({
      bundled,
      answers: {
        '-827_355': [[501, -82.62, 35.5501]],
        '-826_355': [
          [502, -82.59, 35.55],
          [503, -82.5898, 35.5501],
        ],
      },
    })
    const first = await count([mountainRoad], sources)
    // Exactly the two tiles the road is in were asked for, once each, and the count is the whole answer.
    expect(server.requested()).toEqual(['-826_355', '-827_355'])
    expect(first.results).toEqual([[2, 'full']])
    expect(first.loaded.missingTileIds).toEqual([])
    // They are in the device cache now.
    expect((await cache.get('-827_355'))!.nodes).toEqual([{ id: 501, lng: -82.62, lat: 35.5501 }])
    expect((await cache.get('-826_355'))!.nodes).toHaveLength(2)

    // A route inside the bundled area needs no request at all, and leaves nothing in the device cache.
    const bundledRoad = route('bundled', [
      [-80.86, 35.25],
      [-80.84, 35.25],
    ])
    expect((await count([bundledRoad], sources)).results).toEqual([[1, 'full']])
    expect(server.calls).toHaveLength(2)
    expect(await cache.get(WEST)).toBeNull()
  })

  it('sends Overpass the bounding box of each touched tile and nothing about the trip', async () => {
    const { server, sources } = setup()
    const diagonal = route('diagonal', [
      [-80.8431, 35.2271],
      [-80.8295, 35.1527],
      [-80.7712, 35.1234],
    ])
    await count([crossing, diagonal], sources)
    const needed = new Set([...signalTilesForRoute(ROAD), ...signalTilesForRoute(diagonal.geometry)])
    expect(new Set(server.requested())).toEqual(needed)
    expect(server.calls).toHaveLength(needed.size)
    for (const call of server.calls) {
      expect(call.url).toBe(OVERPASS_ENDPOINT)
      expect([...new URLSearchParams(call.body).keys()]).toEqual(['data'])
      // Fixed text around four numbers with one decimal: a whole tile, never a point or a line.
      expect(call.query).toMatch(
        /^\[out:json\]\[timeout:25\];node\[highway=traffic_signals\]\((-?\d+\.\d,){3}-?\d+\.\d\);out;$/,
      )
      expect(call.init?.headers).toBeUndefined()
      expect(call.init?.credentials).toBe('omit')
    }
    // No coordinate of either route appears anywhere in what was sent.
    const sent = server.calls.map((c) => decodeURIComponent(c.body)).join('\n')
    for (const fragment of ['35.25', '80.81', '80.79', '35.2271', '80.8431', '35.1527', '80.8295', '35.1234', '80.7712']) {
      expect(sent).not.toContain(fragment)
    }
  })

  it('does not fetch cached tiles again, in the same session or on a later visit', async () => {
    const answers: Record<string, TileAnswer> = { [WEST]: [[1, -80.805, 35.25]] }
    const first = setup({ answers })
    expect((await count([crossing], first.sources)).results).toEqual([[1, 'full']])
    expect(first.server.requested()).toEqual([EAST, WEST])
    // Same session: a second count, and a different route over the same tiles.
    await count([crossing], first.sources)
    await count([route('back', [...ROAD].reverse())], first.sources)
    expect(first.server.calls).toHaveLength(2)

    // A later visit: new sources (new page) on the same device cache, three weeks on.
    const clock = fakeClock(first.clock.now() + 21 * DAY_MS)
    const later = setup({ answers, cache: first.cache, clock })
    expect((await count([crossing], later.sources)).results).toEqual([[1, 'full']])
    await settle()
    expect(later.server.calls).toHaveLength(0)
  })

  it('counts from a stale tile first, then from the refreshed one', async () => {
    const clock = fakeClock()
    const old = clock.now() - 45 * DAY_MS
    const { server, sources, cache } = setup({
      clock,
      cached: [
        { tileId: WEST, fetchedAt: old, nodes: [{ id: 1, lng: -80.805, lat: 35.25 }] },
        { tileId: EAST, fetchedAt: clock.now(), nodes: [] },
      ],
      // Since the tile was cached, a second signal has been mapped on this road.
      answers: {
        [WEST]: [
          [1, -80.805, 35.25],
          [2, -80.802, 35.25],
        ],
      },
    })
    // The stale tile answers at once: a full count from what the device has.
    expect((await count([crossing], sources)).results).toEqual([[1, 'full']])
    await settle()
    // The refresh ran in the background, for the stale tile only.
    expect(server.requested()).toEqual([WEST])
    expect((await cache.get(WEST))!.fetchedAt).toBe(clock.now())
    expect((await count([crossing], sources)).results).toEqual([[2, 'full']])
    expect(server.calls).toHaveLength(1)
  })

  it('keeps counting from the stale tile when the refresh fails', async () => {
    const clock = fakeClock()
    const stale = { tileId: WEST, fetchedAt: clock.now() - 45 * DAY_MS, nodes: [{ id: 1, lng: -80.805, lat: 35.25 }] }
    const { sources, cache } = setup({
      clock,
      cached: [stale, { tileId: EAST, fetchedAt: clock.now(), nodes: [] }],
      answers: { [WEST]: 504 },
    })
    for (let i = 0; i < 2; i++) {
      expect((await count([crossing], sources)).results).toEqual([[1, 'full']])
      await settle()
    }
    expect(await cache.get(WEST)).toEqual(stale)
  })

  it('shows a partial count, never zero, when a tile cannot be fetched', async () => {
    const { server, sources, clock } = setup({ answers: { [WEST]: [[1, -80.805, 35.25]], [EAST]: 504 } })
    const first = await count([crossing], sources)
    expect(first.loaded.missingTileIds).toEqual([EAST])
    expect(first.results).toEqual([[1, 'partial']])
    expect(first.labels).toEqual(['≥ 1 signal (partial)'])

    // The same failure with no signal found in what did load: still not "0 signals".
    const empty = setup({ answers: { [EAST]: 504 } })
    const none = await count([crossing], empty.sources)
    expect(none.results).toEqual([[0, 'partial']])
    expect(none.labels).toEqual(['Signals: unknown'])

    // Nothing reachable at all (offline, first visit): no count.
    const offline = setup({ answers: { [WEST]: 502, [EAST]: 502 } })
    const nothing = await count([crossing], offline.sources)
    expect(nothing.results).toEqual([[null, 'none']])
    expect(nothing.labels).toEqual(['Signals: unknown'])
    expect(nothing.loaded.missingTileIds).toEqual([EAST, WEST])

    // Back on the first device, a minute later, the server answers: the missing tile is fetched
    // (and only that one) and the count is whole.
    server.answers.set(EAST, [[2, -80.795, 35.25]])
    clock.advance(OVERPASS_COOLDOWN_MS + 1)
    const retried = await count([crossing], sources)
    expect(retried.results).toEqual([[2, 'full']])
    expect(retried.labels).toEqual(['2 signals'])
    expect(server.requested()).toEqual([EAST, WEST, EAST])
  })

  it('counts one intersection on a tile edge once, whichever tiles its nodes came from', async () => {
    // One junction on the edge at longitude -80.8: a signal 14 m west of it, one 14 m east,
    // and one exactly on the edge, which both tile queries return.
    const onEdge = [3, -80.8, 35.2502] as const
    const { sources } = setup({
      answers: {
        [WEST]: [[1, -80.80015, 35.25], onEdge],
        [EAST]: [[2, -80.79985, 35.25], onEdge],
      },
    })
    const { loaded, counted, results } = await count([crossing], sources)
    expect(results).toEqual([[1, 'full']])
    expect(counted.signalsByRouteId.get('crossing')![0]!.mergedIds).toEqual(['osm-1', 'osm-2', 'osm-3'])
    // The node both tiles returned is in the data once.
    expect(loaded.data.primary.map((p) => p.id).sort()).toEqual(['osm-1', 'osm-2', 'osm-3'])
  })

  it('uses OpenStreetMap first and the city list only to fill gaps', async () => {
    const cityList = city(
      // The same junction OpenStreetMap has, placed 20 m away: ignored.
      { id: 'clt-1', position: [-80.8052, 35.2501], name: 'A ST_B ST' },
      // One OpenStreetMap lacks: added.
      { id: 'clt-2', position: [-80.798, 35.25], name: 'A ST_C ST' },
      // The city list covers the city, not this road: a point far away changes nothing.
      { id: 'clt-3', position: [-80.95, 35.4], name: 'X ST_Y ST' },
    )
    const { sources } = setup({ answers: { [WEST]: [[1, -80.805, 35.25]] }, city: cityList })
    const { loaded, counted, results } = await count([crossing], sources)
    expect(results).toEqual([[2, 'full']])
    expect(counted.signalsByRouteId.get('crossing')!.map((s) => [s.id, s.source, s.name])).toEqual([
      ['osm-1', 'primary', null],
      ['clt-2', 'gapFill', 'A ST_C ST'],
    ])
    // The two sources arrive side by side, not merged.
    expect(loaded.data.primary.map((p) => p.id)).toEqual(['osm-1'])
    expect(loaded.data.gapFill!.map((p) => p.id)).toEqual(['clt-1', 'clt-2', 'clt-3'])

    // Without the city list (it failed to load) the OpenStreetMap count stands, in full.
    const alone = setup({ answers: { [WEST]: [[1, -80.805, 35.25]] }, city: NO_CITY })
    const withoutCity = await count([crossing], alone.sources)
    expect(withoutCity.results).toEqual([[1, 'full']])
    expect(withoutCity.loaded.data.gapFill).toBeNull()
  })

  it('falls back on the Mapbox signal flags for a tile that could not be loaded', async () => {
    const intersections: RouteIntersection[] = [
      { location: [-80.805, 35.25], signal: true },
      { location: [-80.795, 35.25], signal: true },
      { location: [-80.792, 35.25], signal: false },
      { location: [-80.791, 35.25], signal: true },
    ]
    const flagged = route('flagged', ROAD, intersections)
    const { sources } = setup({ answers: { [WEST]: [[1, -80.805, 35.25]], [EAST]: 429 } })
    const { counted, results, labels } = await count([flagged], sources)
    expect(results).toEqual([[3, 'partial']])
    expect(labels).toEqual(['≥ 3 signals (partial)'])
    expect(counted.signalsByRouteId.get('flagged')!.map((s) => s.source)).toEqual(['primary', 'fallback', 'fallback'])

    // With the tile loaded, the flags are not used: OpenStreetMap says one signal there, not two.
    const whole = setup({ answers: { [WEST]: [[1, -80.805, 35.25]], [EAST]: [[2, -80.795, 35.25]] } })
    expect((await count([flagged], whole.sources)).results).toEqual([[2, 'full']])
  })

  it('never rejects, whatever a source does', async () => {
    const broken: SignalSources = {
      tiles: { load: () => Promise.reject(new Error('storage exploded')) },
      gapFill: { load: () => Promise.reject(new Error('network exploded')) },
    }
    const loaded = await loadSignalData([crossing], broken)
    expect(loaded.missingTileIds).toEqual([EAST, WEST])
    expect(loaded.data).toEqual({ primary: [], primaryTileIds: new Set(), gapFill: null })
    expect(loaded.primaryDataDate).toBeNull()
    expect(withSignalCounts([crossing], loaded.data).routes[0]!.signalCoverage).toBe('none')
    // No routes, no requests.
    const { server, sources } = setup()
    expect((await loadSignalData([], sources)).missingTileIds).toEqual([])
    expect(server.calls).toHaveLength(0)
  })
})
