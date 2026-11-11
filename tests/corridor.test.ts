import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRIP,
  distanceM,
  formatSignalCount,
  INDIAN_LAND,
  signalTilesForRoute,
  tileIdAt,
  UPTOWN_CHARLOTTE,
  withSignalCounts,
  type RouteCandidate,
} from '../src/core/index.ts'
import { parseDirections } from '../src/providers/mapbox/adapter.ts'
import { createOverpassClient } from '../src/providers/osm/client.ts'
import { createTileSource, memoryTileStore, overpassLayer } from '../src/providers/osm/tileSource.ts'
import { loadSignalData, type SignalSources } from '../src/signalData.ts'
import { fakeOverpass, type NodeSpec, type TileAnswer } from './helpers/overpass.ts'

// A trip down a highway corridor shaped like US-521 south of Charlotte: it starts in the city,
// crosses the state line into South Carolina and ends past a tile edge. Hand-written, with
// made-up positions: the road runs due south along longitude -80.85, a point every 278 m.
//
//   latitude 35.0300  start (in Charlotte)
//            35.0250  signal: two OpenStreetMap approaches of one junction
//            35.0175  signal Mapbox flags but OpenStreetMap does not have
//            35.0130  the state line
//            35.0075  signal
//            35.0000  signal, exactly on the edge between tiles -809_350 and -809_349
//            34.9900  signal, in the southern tile
//            34.9850  end

const STATE_LINE_LAT = 35.013
const NORTH = '-809_350'
const SOUTH = '-809_349'
const LNG = -80.85

function corridor(): RouteCandidate {
  const body: unknown = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'directions.corridor.json'), 'utf8'))
  const parsed = parseDirections(body)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.routes[0]!
}

/** What Overpass would answer for each tile. A node on the shared edge is in both answers. */
const ON_EDGE = [40, LNG - 0.0001, 35.0] as const
const OSM_NORTH: NodeSpec[] = [
  // Two approaches of one junction, 22 m apart.
  [10, LNG, 35.0251],
  [11, LNG, 35.0249],
  [30, LNG + 0.0001, 35.0075],
  // The junction on the tile edge: its northern approach.
  [41, LNG, 35.0001],
  ON_EDGE,
]
const OSM: Record<string, TileAnswer> = {
  [NORTH]: OSM_NORTH,
  [SOUTH]: [
    // Its southern approach, in the other tile.
    [42, LNG, 34.9999],
    ON_EDGE,
    [50, LNG, 34.99],
  ],
}

function sources(answers: Record<string, TileAnswer>): SignalSources {
  const server = fakeOverpass(answers)
  return {
    tiles: createTileSource({
      cache: memoryTileStore(),
      network: overpassLayer(createOverpassClient({ fetchImpl: server.fetchImpl })),
    }),
  }
}

async function count(answers: Record<string, TileAnswer>) {
  const route = corridor()
  const loaded = await loadSignalData([route], sources(answers))
  const counted = withSignalCounts([route], loaded.data)
  const result = counted.routes[0]!
  return {
    loaded,
    result,
    signals: counted.signalsByRouteId.get(route.id) ?? [],
    label: formatSignalCount(result.signalCount, result.signalCoverage),
  }
}

describe('the default trip', () => {
  it('runs from Uptown Charlotte to US-521 and SC-160 in Indian Land, South Carolina', () => {
    expect(DEFAULT_TRIP).toEqual({ origin: UPTOWN_CHARLOTTE, destination: INDIAN_LAND })
    // About 25 km apart as the crow flies, the destination due south and across the state line.
    const d = distanceM(DEFAULT_TRIP.origin.position, DEFAULT_TRIP.destination.position)
    expect(d).toBeGreaterThan(24_000)
    expect(d).toBeLessThan(26_500)
    expect(INDIAN_LAND.position[1]).toBeLessThan(STATE_LINE_LAT)
    expect(INDIAN_LAND.label).toContain('US-521')
    // The two ends are in different tiles, three tiles apart.
    expect(tileIdAt(UPTOWN_CHARLOTTE.position)).toBe('-809_352')
    expect(tileIdAt(INDIAN_LAND.position)).toBe('-809_350')
  })
})

describe('a corridor trip across the state line', () => {
  it('is a route with tiles on both sides of a tile edge and of the state line', () => {
    const route = corridor()
    expect(signalTilesForRoute(route.geometry)).toEqual([SOUTH, NORTH])
    expect(route.geometry[0]![1]).toBeGreaterThan(STATE_LINE_LAT)
    expect(route.geometry.at(-1)![1]).toBeLessThan(STATE_LINE_LAT)
    // A highway with signals, not a freeway: nothing is filtered as limited-access.
    expect(route.limitedAccessSpansM).toEqual([])
    expect(route.providerSignalCount).toBe(5)
  })

  it('counts every OpenStreetMap signal once, and only those, when every tile loaded', async () => {
    const { result, signals, label, loaded } = await count(OSM)
    expect([result.signalCount, result.signalCoverage]).toEqual([4, 'full'])
    expect(label).toBe('4 signals')
    expect(loaded.missingTileIds).toEqual([])
    // The Mapbox flag at 35.0175 is in a loaded tile, so OpenStreetMap's answer stands there.
    expect(signals.map((s) => [s.id, s.source])).toEqual([
      ['osm-10', 'primary'],
      ['osm-30', 'primary'],
      ['osm-40', 'primary'],
      ['osm-50', 'primary'],
    ])
  })

  it('counts on both sides of the state line from the same data', async () => {
    const { signals } = await count(OSM)
    expect(signals.filter((s) => s.position[1] > STATE_LINE_LAT).map((s) => s.id)).toEqual(['osm-10'])
    expect(signals.filter((s) => s.position[1] < STATE_LINE_LAT).map((s) => s.id)).toEqual(['osm-30', 'osm-40', 'osm-50'])

    // Without OpenStreetMap's nodes south of the line there is nothing there at all: a full count of what is known.
    const northOnly = await count({ [NORTH]: OSM_NORTH.slice(0, 2), [SOUTH]: [] })
    expect([northOnly.result.signalCount, northOnly.result.signalCoverage]).toEqual([1, 'full'])
    expect(northOnly.signals.every((s) => s.position[1] > STATE_LINE_LAT)).toBe(true)
  })

  it('counts the intersection on the tile edge once', async () => {
    const { signals, loaded } = await count(OSM)
    const onEdge = signals.filter((s) => Math.abs(s.position[1] - 35.0) < 0.001)
    expect(onEdge).toHaveLength(1)
    // Its three nodes came from two tiles, one of them from both.
    expect(onEdge[0]!.mergedIds).toEqual(['osm-40', 'osm-41', 'osm-42'])
    expect(loaded.data.primary.filter((p) => p.id === 'osm-40')).toHaveLength(1)
  })

  it('says partial, with the Mapbox flags standing in, when the tile south of the edge is missing', async () => {
    const { result, signals, label, loaded } = await count({ ...OSM, [SOUTH]: 504 })
    expect(loaded.missingTileIds).toEqual([SOUTH])
    expect([result.signalCount, result.signalCoverage]).toEqual([4, 'partial'])
    expect(label).toBe('≥ 4 signals (partial)')
    // The edge junction is still one signal (its northern nodes loaded), and the last one is a Mapbox flag.
    expect(signals.map((s) => s.source)).toEqual(['primary', 'primary', 'primary', 'fallback'])
  })

  it('never says 0 when every tile is missing: the Mapbox flags give a lower bound, or the count is unknown', async () => {
    const offline = await count({ [NORTH]: 504, [SOUTH]: 504 })
    expect(offline.result.signalCoverage).toBe('partial')
    expect(offline.label).toBe('≥ 5 signals (partial)')
    expect(offline.signals.every((s) => s.source === 'fallback')).toBe(true)
  })
})
