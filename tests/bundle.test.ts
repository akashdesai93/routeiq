import { describe, expect, it } from 'vitest'
import {
  signalTilesForRoute,
  tileBounds,
  tileIdAt,
  withSignalCounts,
  type LngLat,
  type RouteCandidate,
} from '../src/core/index.ts'
import { isOsmSignalTile, type OsmSignalNode, type OsmSignalTile } from '../src/providers/osm/adapter.ts'
import {
  buildBundleIndex,
  classifySignalTags,
  decodeTileRows,
  encodeTileRows,
  EXCLUDED_SIGNAL_SUBTYPES,
  groupIntoTiles,
  isOsmBundleIndex,
  OSM_BUNDLE_PATH,
  tileRowsHas,
} from '../src/providers/osm/bundle.ts'
import { createBundleLayer, memoryBundleLayer } from '../src/providers/osm/bundleLayer.ts'
import { boxFullyInside, fullyCoveredTiles, parsePoly, pointInPoly, type BoundaryPoly } from '../src/providers/osm/coverage.ts'
import { createTileSource, memoryTileStore, type TileLayer } from '../src/providers/osm/tileSource.ts'
import { loadSignalData, type SignalSources } from '../src/signalData.ts'
import { settle } from './helpers/overpass.ts'

// The bundle: OpenStreetMap signal tiles built ahead of time from regional extracts and served
// with the app. No test here touches the network or needs an extract; the "static files" are a
// stand-in fetch over an object of paths, the boundaries are simple shapes, and positions are made up.

const DATA_DATE = 1_794_345_699_000
const NOW = 1_800_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000

function route(id: string, geometry: readonly LngLat[], intersections: RouteCandidate['intersections'] = null): RouteCandidate {
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

/** Serves JSON "files" by URL, counts what was asked for, and answers 404 for the rest. */
function staticFiles(files: Record<string, unknown>) {
  const requested: string[] = []
  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    if (!(url in files)) return Promise.resolve(new Response('<!doctype html><title>Not found</title>', { status: 404 }))
    const file = files[url]
    return Promise.resolve(new Response(typeof file === 'string' ? file : JSON.stringify(file)))
  }) as typeof fetch
  return { fetchImpl, requested, files }
}

/** A network that must not be asked: every call is recorded. */
function recordingNetwork(answer: (tileId: string) => OsmSignalTile | null = () => null) {
  const asked: string[] = []
  const layer: TileLayer = {
    get: (tileId) => {
      asked.push(tileId)
      return Promise.resolve(answer(tileId))
    },
  }
  return { layer, asked }
}

/** A square boundary, as a .poly file would describe it. */
function square(name: string, west: number, south: number, east: number, north: number): BoundaryPoly {
  return parsePoly(
    [name, '1', `   ${west}   ${south}`, `   ${east}   ${south}`, `   ${east}   ${north}`, `   ${west}   ${north}`, 'END', 'END', ''].join('\n'),
  )!
}

describe('classifySignalTags', () => {
  it('keeps highway=traffic_signals, with or without an ordinary subtype', () => {
    expect(classifySignalTags({ highway: 'traffic_signals' })).toEqual({ keep: true, kind: 'unspecified' })
    expect(classifySignalTags({ highway: 'traffic_signals', traffic_signals: 'signal' })).toEqual({ keep: true, kind: 'signal' })
    expect(classifySignalTags({ highway: 'traffic_signals', traffic_signals: 'Traffic_Lights ' }).keep).toBe(true)
    expect(classifySignalTags({ highway: 'traffic_signals', traffic_signals: 'continuous_green' }).keep).toBe(true)
    // An intersection signal that also has pedestrian signals is still an intersection signal.
    expect(classifySignalTags({ highway: 'traffic_signals', crossing: 'traffic_signals' }).keep).toBe(true)
  })

  it('leaves out flashers, emergency signals, ramp meters and pedestrian-only signals', () => {
    for (const subtype of ['blinker', 'emergency', 'ramp_meter', 'pedestrian_crossing', 'crossing', 'level_crossing']) {
      expect(EXCLUDED_SIGNAL_SUBTYPES.has(subtype)).toBe(true)
      expect(classifySignalTags({ highway: 'traffic_signals', traffic_signals: subtype })).toEqual({ keep: false, kind: subtype })
    }
    // Several kinds at one node: kept unless every one of them is excluded.
    expect(classifySignalTags({ highway: 'traffic_signals', traffic_signals: 'signal;emergency' }).keep).toBe(true)
    expect(classifySignalTags({ highway: 'traffic_signals', traffic_signals: 'blinker; emergency' }).keep).toBe(false)
  })

  it('does not take a pedestrian crossing signal, or anything else, for a traffic signal', () => {
    expect(classifySignalTags({ highway: 'crossing', crossing: 'traffic_signals' })).toEqual({ keep: false, kind: 'crossing_only' })
    expect(classifySignalTags({ highway: 'crossing', crossing: 'marked' })).toEqual({ keep: false, kind: 'not_a_signal' })
    expect(classifySignalTags({ railway: 'signal' }).keep).toBe(false)
    expect(classifySignalTags({}).keep).toBe(false)
  })
})

describe('groupIntoTiles', () => {
  const nodes: OsmSignalNode[] = [
    { id: 7, lng: -80.8431, lat: 35.2271 },
    { id: 3, lng: -80.8433, lat: 35.2272 },
    { id: 5, lng: -80.75, lat: 35.25 },
    // Exactly on the edge between -809_352 and -808_352.
    { id: 9, lng: -80.8, lat: 35.26 },
    { id: 12, lng: 999, lat: 35.25 },
  ]

  it('writes a tile for every tile with a signal, and none for the rest', () => {
    const tiles = groupIntoTiles(nodes, DATA_DATE)
    expect(tiles.map((t) => t.tileId)).toEqual(['-808_352', '-809_352'])
    for (const tile of tiles) {
      // Exactly the shape the app's cache and the bundle layer take.
      expect(isOsmSignalTile(tile)).toBe(true)
      expect(Object.keys(tile)).toEqual(['tileId', 'fetchedAt', 'nodes'])
      expect(tile.fetchedAt).toBe(DATA_DATE)
      expect(tile.nodes.length).toBeGreaterThan(0)
    }
    for (const node of nodes.slice(0, 4)) {
      const home = tiles.find((t) => t.tileId === tileIdAt([node.lng, node.lat]))!
      expect(home.nodes).toContainEqual(node)
    }
  })

  it('puts a node on a tile edge in both tiles, sorts by id, and keeps a node given twice once', () => {
    const tiles = groupIntoTiles([...nodes, nodes[0]!], DATA_DATE)
    expect(tiles[0]!.nodes.map((n) => n.id)).toEqual([5, 9])
    expect(tiles[1]!.nodes.map((n) => n.id)).toEqual([3, 7, 9])
    expect(groupIntoTiles([], DATA_DATE)).toEqual([])
  })
})

describe('tile rows', () => {
  it('writes a set of tiles as runs along each row, and reads it back', () => {
    const ids = ['-809_352', '-808_352', '-807_352', '-805_352', '-809_351', '-1_0', '0_0', '1_0', '5_-3']
    const rows = encodeTileRows(ids)
    expect(rows).toEqual({ '-3': [5, 5], '0': [-1, 1], '351': [-809, -809], '352': [-809, -807, -805, -805] })
    expect(decodeTileRows(rows).sort()).toEqual([...ids].sort())
    for (const id of ids) expect(tileRowsHas(rows, id), id).toBe(true)
    for (const id of ['-806_352', '-810_352', '-804_352', '-809_353', '2_0', 'nonsense', '']) {
      expect(tileRowsHas(rows, id), id).toBe(false)
    }
    // Repeats and things that are not tiles do not matter.
    expect(encodeTileRows(['0_0', '0_0', 'x', '1_0'])).toEqual({ '0': [0, 1] })
    expect(encodeTileRows([])).toEqual({})
  })

  it('is far smaller than the list it stands for', () => {
    // A block the size of a state: 60 by 40 tiles.
    const ids: string[] = []
    for (let x = -840; x < -780; x++) for (let y = 330; y < 370; y++) ids.push(`${x}_${y}`)
    const rows = encodeTileRows(ids)
    expect(decodeTileRows(rows)).toHaveLength(2400)
    expect(JSON.stringify(rows).length).toBeLessThan(JSON.stringify(ids).length / 20)
  })
})

describe('the bundle index', () => {
  const tiles = groupIntoTiles(
    [
      { id: 1, lng: -80.805, lat: 35.25 },
      { id: 2, lng: -80.8, lat: 35.26 },
      { id: 3, lng: -80.45, lat: 35.25 },
    ],
    DATA_DATE,
  )
  const covered = ['-809_352', '-808_352', '-807_352']
  const index = buildBundleIndex(tiles, covered, [
    { name: 'north-carolina', dataDate: DATA_DATE + DAY_MS },
    { name: 'south-carolina', dataDate: DATA_DATE },
  ])

  it('says which tiles are covered, which have a file, how old the data is and whose it is', () => {
    expect(index.version).toBe(2)
    expect(index.covered).toEqual({ '352': [-809, -807] })
    expect(index.files).toEqual({ '352': [-809, -808, -805, -805] })
    // The oldest extract dates the whole bundle.
    expect(index.dataDate).toBe(DATA_DATE)
    expect(index.source).toContain('Geofabrik')
    expect(index.source).toContain('north-carolina, south-carolina')
    // The node on the edge is in two tiles and counted once.
    expect(index.nodeCount).toBe(3)
    expect(index.attribution).toBe('© OpenStreetMap contributors')
    expect(index.license).toContain('ODbL')
    expect(index.license).toContain('https://www.openstreetmap.org/copyright')
  })

  it('is checked before it is trusted', () => {
    expect(isOsmBundleIndex(JSON.parse(JSON.stringify(index)))).toBe(true)
    expect(isOsmBundleIndex({ ...index, version: 1 })).toBe(false)
    expect(isOsmBundleIndex({ ...index, dataDate: 'Nov 2026' })).toBe(false)
    expect(isOsmBundleIndex({ ...index, covered: { '352': [-809] } })).toBe(false)
    expect(isOsmBundleIndex({ ...index, covered: { '352': [-807, -809] } })).toBe(false)
    expect(isOsmBundleIndex({ ...index, files: { north: [1, 2] } })).toBe(false)
    expect(isOsmBundleIndex({ ...index, files: ['-809_352'] })).toBe(false)
    // The index of the old Overpass seed (a bbox and a list of ids) is not a bundle index.
    expect(isOsmBundleIndex({ bbox: [-81.2, 34.8, -80.5, 35.5], fetchedAt: NOW, tiles: ['-809_352'] })).toBe(false)
    expect(isOsmBundleIndex(null)).toBe(false)
  })
})

describe('coverage: which tiles lie entirely inside the boundaries', () => {
  it('reads a .poly boundary file, holes included, and nothing else', () => {
    const poly = parsePoly(
      ['none', '1', '   -8.10E+01   3.50E+01', '   -8.00E+01   3.50E+01', '   -8.00E+01   3.60E+01', '   -8.10E+01   3.60E+01', 'END',
        '!2', '  -80.6 35.4', '  -80.4 35.4', '  -80.4 35.6', '  -80.6 35.6', 'END', 'END'].join('\r\n'),
    )!
    expect(poly.rings.map((r) => [r.hole, r.points.length])).toEqual([[false, 4], [true, 4]])
    expect(poly.bbox).toEqual([-81, 35, -80, 36])
    expect(pointInPoly(poly, [-80.9, 35.1])).toBe(true)
    expect(pointInPoly(poly, [-80.5, 35.5])).toBe(false)
    expect(pointInPoly(poly, [-79.9, 35.5])).toBe(false)
    for (const bad of ['', 'none\n1\n -80 35\n -81 35\nEND\nEND', 'none\n1\n -80 thirty\n -81 35\n -81 36\nEND\nEND', 'none\n1\n -80 35\n -81 35\n -81 36']) {
      expect(parsePoly(bad), bad).toBeNull()
    }
  })

  it('counts a tile only when all of it is inside: a tile that pokes out is not covered', () => {
    // The boundary cuts through the tiles of column -810 and row 349.
    const state = square('state', -80.95, 34.95, -80.6, 35.3)
    expect(boxFullyInside(tileBounds('-809_352')!, [state])).toBe(true)
    expect(boxFullyInside(tileBounds('-810_352')!, [state])).toBe(false)
    expect(boxFullyInside(tileBounds('-809_349')!, [state])).toBe(false)
    expect(boxFullyInside(tileBounds('-850_352')!, [state])).toBe(false)
    const covered = fullyCoveredTiles([state])
    // Columns -809 to -807 (the east edge at -80.6 is a tile edge), rows 350 to 352.
    expect(covered).toHaveLength(9)
    for (const id of covered) {
      const [w, s, e, n] = tileBounds(id)!
      expect(w >= -80.95 && e <= -80.6 + 1e-9 && s >= 34.95 && n <= 35.3 + 1e-9, id).toBe(true)
    }
    expect(covered).toContain('-807_350')
    expect(covered).not.toContain('-806_350')
  })

  it('covers a tile that straddles two states that share a border, but not one across a gap between them', () => {
    // North and south meet along latitude 35.05, in the middle of row 350.
    const north = square('north', -81, 35.05, -80.5, 35.4)
    const south = square('south', -81, 34.7, -80.5, 35.05)
    expect(boxFullyInside(tileBounds('-808_350')!, [north])).toBe(false)
    expect(boxFullyInside(tileBounds('-808_350')!, [south])).toBe(false)
    expect(boxFullyInside(tileBounds('-808_350')!, [north, south])).toBe(true)
    // Overlapping boundaries are fine too.
    expect(boxFullyInside(tileBounds('-808_350')!, [north, square('south', -81, 34.7, -80.5, 35.07)])).toBe(true)
    // A sliver between them 100 m wide (signals in it would be in neither extract): not covered.
    const short = square('south', -81, 34.7, -80.5, 35.049)
    expect(boxFullyInside(tileBounds('-808_350')!, [north, short])).toBe(false)
    expect(boxFullyInside(tileBounds('-808_351')!, [north, short])).toBe(true)
    const together = fullyCoveredTiles([north, south])
    // 5 columns by 7 rows (347 to 353), the border row included.
    expect(together).toHaveLength(35)
    expect(fullyCoveredTiles([north, short])).toHaveLength(30)
  })

  it('does not cover a tile with a hole in it', () => {
    const holed = parsePoly(
      ['x', '1', '-81 35', '-80 35', '-80 36', '-81 36', 'END', '!2', '-80.56 35.52', '-80.54 35.52', '-80.54 35.54', '-80.56 35.54', 'END', 'END'].join('\n'),
    )!
    expect(boxFullyInside(tileBounds('-806_355')!, [holed])).toBe(false)
    expect(boxFullyInside(tileBounds('-807_355')!, [holed])).toBe(true)
  })
})

describe('the bundle layer', () => {
  const BASE = `/${OSM_BUNDLE_PATH}`
  const WEST = '-809_352'
  const EAST = '-808_352'
  const EMPTY = '-807_352'
  const EDGE = '-806_352'
  /** WEST and EAST have signals, EMPTY is covered without any, EDGE has a file but pokes outside. */
  const bundleFiles = () => {
    const tiles = groupIntoTiles(
      [
        { id: 1, lng: -80.805, lat: 35.25 },
        { id: 2, lng: -80.795, lat: 35.25 },
        { id: 3, lng: -80.55, lat: 35.25 },
      ],
      DATA_DATE,
    )
    const index = buildBundleIndex(tiles, [WEST, EAST, EMPTY], [{ name: 'north-carolina', dataDate: DATA_DATE }])
    return {
      [`${BASE}/index.json`]: index,
      ...Object.fromEntries(tiles.map((tile) => [`${BASE}/${tile.tileId}.json`, tile])),
    }
  }
  const ROAD: LngLat[] = [
    [-80.81, 35.25],
    [-80.79, 35.25],
  ]

  it('says how the bundle stands on a tile, reading the index once', async () => {
    const files = staticFiles(bundleFiles())
    const layer = createBundleLayer({ baseUrl: BASE, fetchImpl: files.fetchImpl })
    expect(await Promise.all([WEST, EAST, EMPTY, EDGE, '-827_355'].map((id) => layer.coverage(id)))).toEqual([
      'covered',
      'covered',
      'covered',
      'clipped',
      'none',
    ])
    expect(files.requested).toEqual([`${BASE}/index.json`])
  })

  it('answers a covered tile without signals from the index alone: no file, no request, no 404', async () => {
    const files = staticFiles(bundleFiles())
    const layer = createBundleLayer({ baseUrl: BASE, fetchImpl: files.fetchImpl })
    expect(await layer.get(EMPTY)).toEqual({ tileId: EMPTY, fetchedAt: DATA_DATE, nodes: [] })
    // A tile outside the bundle costs nothing here either.
    expect(await layer.get('-827_355')).toBeNull()
    expect(files.requested).toEqual([`${BASE}/index.json`])
    expect((await layer.get(WEST))!.nodes).toEqual([{ id: 1, lng: -80.805, lat: 35.25 }])
    expect((await layer.get(EDGE))!.nodes).toHaveLength(1)
    expect(files.requested).toEqual([`${BASE}/index.json`, `${BASE}/${WEST}.json`, `${BASE}/${EDGE}.json`])
  })

  it('covers nothing without an index, and looks for one again next time', async () => {
    // What a dev server answers for a file that is not there: a web page with status 200.
    const files = staticFiles({ [`${BASE}/index.json`]: '<!doctype html><div id="root"></div>' })
    const layer = createBundleLayer({ baseUrl: BASE, fetchImpl: files.fetchImpl })
    expect(await layer.coverage(WEST)).toBe('none')
    expect(await layer.get(WEST)).toBeNull()
    Object.assign(files.files, bundleFiles())
    expect(await layer.coverage(WEST)).toBe('covered')
    expect((await layer.get(WEST))!.nodes).toHaveLength(1)
  })

  it('treats a damaged or mislabelled tile file as missing, and never rejects', async () => {
    const files = staticFiles({
      ...bundleFiles(),
      [`${BASE}/${WEST}.json`]: { tileId: EAST, fetchedAt: NOW, nodes: [] },
      [`${BASE}/${EAST}.json`]: '<html>502 Bad Gateway</html>',
    })
    const layer = createBundleLayer({ baseUrl: BASE, fetchImpl: files.fetchImpl })
    expect(await layer.get(WEST)).toBeNull()
    expect(await layer.get(EAST)).toBeNull()
    const broken = createBundleLayer({ baseUrl: BASE, fetchImpl: () => Promise.reject(new Error('offline')) })
    expect(await broken.coverage(WEST)).toBe('none')
    expect(await broken.get(WEST)).toBeNull()
  })

  it('gives a full count with no network and no cache, an honest "0 signals" included', async () => {
    const files = staticFiles(bundleFiles())
    const network = recordingNetwork()
    const cache = memoryTileStore()
    const sources: SignalSources = {
      tiles: createTileSource({
        bundle: createBundleLayer({ baseUrl: BASE, fetchImpl: files.fetchImpl }),
        cache,
        network: network.layer,
        now: () => NOW,
      }),
    }
    const road = route('bundled', ROAD)
    expect(signalTilesForRoute(road.geometry)).toEqual([EAST, WEST])
    const loaded = await loadSignalData([road], sources)
    expect(loaded.missingTileIds).toEqual([])
    expect(loaded.primaryDataDate).toBe(DATA_DATE)
    const counted = withSignalCounts([road], loaded.data).routes[0]!
    expect([counted.signalCount, counted.signalCoverage]).toEqual([2, 'full'])

    // A road through the covered tile without signals: zero, in full, from the index alone.
    const quiet = route('quiet', [
      [-80.66, 35.25],
      [-80.64, 35.25],
    ])
    const none = await loadSignalData([quiet], sources)
    expect(none.missingTileIds).toEqual([])
    const zero = withSignalCounts([quiet], none.data).routes[0]!
    expect([zero.signalCount, zero.signalCoverage]).toEqual([0, 'full'])

    // Nothing was asked of the network, and nothing was copied into the device cache.
    expect(network.asked).toEqual([])
    for (const id of [WEST, EAST, EMPTY]) expect(await cache.get(id)).toBeNull()
  })

  it('asks the network only for the tiles the bundle does not cover in full', async () => {
    const files = staticFiles(bundleFiles())
    const network = recordingNetwork((tileId) => ({ tileId, fetchedAt: NOW, nodes: [] }))
    const cache = memoryTileStore()
    const tiles = createTileSource({
      bundle: createBundleLayer({ baseUrl: BASE, fetchImpl: files.fetchImpl }),
      cache,
      network: network.layer,
      now: () => NOW,
    })
    const loaded = await tiles.load([WEST, EAST, EMPTY, EDGE, '-805_352'])
    expect(loaded.missing).toEqual([])
    // The clipped tile and the one outside went to the network; its answer is the whole tile, and is cached.
    expect(network.asked.sort()).toEqual(['-805_352', EDGE])
    expect(loaded.tiles.get(EDGE)).toEqual({ tileId: EDGE, fetchedAt: NOW, nodes: [] })
    expect(await cache.get(EDGE)).not.toBeNull()
    expect(await cache.get(WEST)).toBeNull()
  })
})

describe('createTileSource with a bundle: bundle, then cache, then network', () => {
  const WEST = '-809_352'
  const EDGE = '-806_352'
  const node = (id: number, lng = -80.85) => ({ id, lng, lat: 35.25 })
  const tileAt = (tileId: string, fetchedAt: number, ...nodes: OsmSignalNode[]): OsmSignalTile => ({ tileId, fetchedAt, nodes })

  it('takes a covered tile from the bundle even when the device cache holds a copy of it', async () => {
    // Cached from Overpass before the bundle existed, with one signal fewer.
    const cache = memoryTileStore([tileAt(WEST, DATA_DATE - 90 * DAY_MS, node(1))])
    const network = recordingNetwork()
    const source = createTileSource({
      bundle: memoryBundleLayer([tileAt(WEST, DATA_DATE, node(1), node(2))]),
      cache,
      network: network.layer,
      now: () => NOW,
    })
    expect((await source.load([WEST])).tiles.get(WEST)!.nodes.map((n) => n.id)).toEqual([1, 2])
    await settle()
    // The cache was neither read into the answer nor rewritten.
    expect((await cache.get(WEST))!.nodes).toHaveLength(1)
    expect(network.asked).toEqual([])
  })

  it('never refreshes a bundled tile from the network, however old the bundle is', async () => {
    const network = recordingNetwork((tileId) => tileAt(tileId, NOW, node(99)))
    const source = createTileSource({
      bundle: memoryBundleLayer([tileAt(WEST, NOW - 400 * DAY_MS, node(1))], [WEST, '-808_352'], NOW - 400 * DAY_MS),
      cache: memoryTileStore(),
      network: network.layer,
      now: () => NOW,
    })
    for (let i = 0; i < 2; i++) {
      const loaded = await source.load([WEST, '-808_352'])
      expect(loaded.tiles.get(WEST)!.nodes.map((n) => n.id)).toEqual([1])
      expect(loaded.tiles.get('-808_352')!.nodes).toEqual([])
      await settle()
    }
    expect(network.asked).toEqual([])
  })

  it('does not fall back on the network for a covered tile whose file cannot be read', async () => {
    const network = recordingNetwork((tileId) => tileAt(tileId, NOW, node(99)))
    const bundle = { coverage: () => Promise.resolve('covered' as const), get: () => Promise.resolve(null) }
    const source = createTileSource({ bundle, cache: memoryTileStore(), network: network.layer, now: () => NOW })
    expect((await source.load([WEST])).missing).toEqual([WEST])
    expect(network.asked).toEqual([])
  })

  it('hands back the clipped part of an edge tile when the network fails, as a lower bound only', async () => {
    const edgePart = tileAt(EDGE, DATA_DATE, node(7, -80.55))
    let online = false
    const network = recordingNetwork((tileId) => (online ? tileAt(tileId, NOW, node(7, -80.55), node(8, -80.52)) : null))
    let nowMs = NOW
    const sources: SignalSources = {
      tiles: createTileSource({
        bundle: memoryBundleLayer([tileAt(WEST, DATA_DATE, node(1)), edgePart], [WEST]),
        cache: memoryTileStore(),
        network: network.layer,
        now: () => nowMs,
      }),
    }
    // A road across the edge tile, with Mapbox flagging the signal the extract was clipped before.
    const road = route(
      'edge',
      [
        [-80.56, 35.25],
        [-80.51, 35.25],
      ],
      [
        { location: [-80.55, 35.25], signal: true },
        { location: [-80.52, 35.25], signal: true },
      ],
    )
    const loaded = await loadSignalData([road], sources)
    expect(loaded.missingTileIds).toEqual([EDGE])
    // The clipped part's signal is among the points, but the tile is not listed as loaded.
    expect(loaded.data.primary.map((p) => p.id)).toEqual(['osm-7'])
    expect(loaded.data.primaryTileIds.has(EDGE)).toBe(false)
    const counted = withSignalCounts([road], loaded.data)
    expect([counted.routes[0]!.signalCount, counted.routes[0]!.signalCoverage]).toEqual([2, 'partial'])
    // The bundled signal and the Mapbox flag on top of it are one signal, credited to OpenStreetMap.
    expect(counted.signalsByRouteId.get('edge')!.map((s) => s.source)).toEqual(['primary', 'fallback'])

    // When the network is back (and the wait is over), its tile is the whole answer.
    online = true
    nowMs += 31_000
    const later = await loadSignalData([road], sources)
    expect(later.missingTileIds).toEqual([])
    expect(withSignalCounts([road], later.data).routes[0]).toMatchObject({ signalCount: 2, signalCoverage: 'full' })
  })
})

describe('createTileSource: a tile that failed is left alone for a while', () => {
  const OUTSIDE = '-827_355'
  const OTHER = '-826_355'

  it('does not ask for a failed tile again on every load, and waits longer each time it fails', async () => {
    let nowMs = NOW
    const network = recordingNetwork()
    const source = createTileSource({ cache: memoryTileStore(), network: network.layer, now: () => nowMs })
    const askedAfter = async (advanceMs: number) => {
      nowMs += advanceMs
      expect((await source.load([OUTSIDE])).missing).toEqual([OUTSIDE])
      return network.asked.length
    }
    expect(await askedAfter(0)).toBe(1)
    // A route recounted every five seconds (rerouting) for half a minute: no further request.
    for (let tick = 0; tick < 5; tick++) expect(await askedAfter(5_000)).toBe(1)
    // After 30 s it is tried once more; it fails again, and the wait doubles to a minute.
    expect(await askedAfter(5_001)).toBe(2)
    expect(await askedAfter(59_000)).toBe(2)
    expect(await askedAfter(1_001)).toBe(3)
    // The wait never grows past eight minutes.
    for (let i = 0; i < 6; i++) await askedAfter(8 * 60_000 + 1)
    expect(network.asked).toHaveLength(9)
    expect(await askedAfter(8 * 60_000 - 1)).toBe(9)
  })

  it('keeps the wait per tile, forgets it on success, and skips it when the user asks for a retry', async () => {
    let nowMs = NOW
    let online = false
    const network = recordingNetwork((tileId) => (online || tileId === OTHER ? { tileId, fetchedAt: nowMs, nodes: [] } : null))
    const source = createTileSource({ cache: memoryTileStore(), network: network.layer, now: () => nowMs })
    expect((await source.load([OUTSIDE])).missing).toEqual([OUTSIDE])
    // Another tile is not held back by the first one's failure.
    expect((await source.load([OUTSIDE, OTHER])).missing).toEqual([OUTSIDE])
    expect(network.asked).toEqual([OUTSIDE, OTHER])
    // "Retry signals": asked again at once.
    expect((await source.load([OUTSIDE], { retryFailed: true })).missing).toEqual([OUTSIDE])
    expect(network.asked).toEqual([OUTSIDE, OTHER, OUTSIDE])
    online = true
    expect((await source.load([OUTSIDE])).missing).toEqual([OUTSIDE])
    expect((await source.load([OUTSIDE], { retryFailed: true })).missing).toEqual([])
    // Loaded: from now on it is answered from memory.
    nowMs += 60 * 60_000
    expect((await source.load([OUTSIDE])).missing).toEqual([])
    expect(network.asked).toHaveLength(4)
  })
})
