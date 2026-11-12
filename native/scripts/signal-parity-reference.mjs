#!/usr/bin/env node
// Writes the expected signal counts that RouteIQKit's SignalBundle must
// reproduce: the web app's OWN code (src/core, the Mapbox adapter, the bundle
// layer and the tile source, run by Node's TypeScript type stripping) counts
// signals on the real bundled tiles, with the bundle as the only source (the
// network layer always misses, as in the app). The Swift test
// SignalBundleParityTests compares against this file.
//
// Usage (from the repository root, Node 24 or newer):
//   node native/scripts/signal-parity-reference.mjs > native/RouteIQCore/Tests/RouteIQKitTests/Fixtures/signal-parity.json

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const { withSignalCounts, signalTilesForRoute, routeIdFromGeometry, alongRouteM } = await import(
  join(root, 'src/core/index.ts').replaceAll('\\', '/').replace(/^([A-Za-z]):/, 'file:///$1:')
)
const imp = (p) => import(join(root, p).replaceAll('\\', '/').replace(/^([A-Za-z]):/, 'file:///$1:'))
const { parseDirections } = await imp('src/providers/mapbox/adapter.ts')
const { createBundleLayer } = await imp('src/providers/osm/bundleLayer.ts')
const { createTileSource, memoryTileStore } = await imp('src/providers/osm/tileSource.ts')
const { osmSignalPoints } = await imp('src/providers/osm/adapter.ts')
const { decodeTileRows, tileRowsHas } = await imp('src/providers/osm/bundle.ts')

const bundleDir = join(root, 'public/seed/osm-signals')
// The bundle layer reads its files through fetch; here they come from disk.
const fetchImpl = async (url) => {
  const name = url.split('/').pop()
  try {
    return new Response(readFileSync(join(bundleDir, name)), { status: 200 })
  } catch {
    return new Response('', { status: 404 })
  }
}
const tiles = createTileSource({
  bundle: createBundleLayer({ baseUrl: '/seed/osm-signals', fetchImpl }),
  cache: memoryTileStore(),
  network: { get: async () => null },
})

/** loadSignalData (src/signalData.ts) without the city list, which the app does not use. */
async function signalData(routes) {
  const tileIds = [...new Set(routes.flatMap((r) => signalTilesForRoute(r.geometry)))].sort()
  const loaded = await tiles.load(tileIds)
  return {
    data: {
      primary: osmSignalPoints([...loaded.tiles.values(), ...loaded.partial.values()]),
      primaryTileIds: new Set(loaded.tiles.keys()),
    },
    missingTileIds: [...loaded.missing],
  }
}

const fixture = (name) => JSON.parse(readFileSync(join(root, 'tests/fixtures', name), 'utf8'))
const sets = []
for (const name of ['directions.ok.json', 'directions.corridor.json', 'directions.freeway.json']) {
  const result = parseDirections(fixture(name))
  if (!result.ok) throw new Error(`${name}: ${result.kind}`)
  sets.push({ name, routes: result.routes })
}

const line = (name, geometry, intersections = null) => {
  const along = alongRouteM(geometry)
  return {
    id: routeIdFromGeometry(geometry), geometry, durationSec: 600, typicalDurationSec: 600, distanceM: along.at(-1),
    signalCount: null, signalCoverage: 'none', providerSignalCount: null, intersections,
    limitedAccessSpansM: null, maneuvers: [], name,
  }
}
// Leaves the covered area: Uptown Charlotte towards Atlanta, Georgia.
sets.push({ name: 'leaves-carolinas', routes: [line('leaves', [[-80.8431, 35.2271], [-81.5, 34.9], [-84.388, 33.749]])] })
// The first few clipped tiles (a file, but outside the covered area): a line through two of the
// tile's own signal nodes, with an intersection list (empty, so rule (c) is skipped) so that the
// route is not "nothing known" and the clipped part counts as a lower bound.
const index = JSON.parse(readFileSync(join(bundleDir, 'index.json'), 'utf8'))
const clipped = decodeTileRows(index.files).filter((id) => !tileRowsHas(index.covered, id)).slice(0, 3)
for (const id of clipped) {
  const nodes = JSON.parse(readFileSync(join(bundleDir, `${id}.json`), 'utf8')).nodes
  const a = nodes[0]
  const b = nodes[nodes.length - 1]
  const geometry = a.id === b.id ? [[a.lng, a.lat], [a.lng + 0.001, a.lat + 0.001]] : [[a.lng, a.lat], [b.lng, b.lat]]
  sets.push({ name: `clipped-${id}`, routes: [line(`clipped-${id}`, geometry, [])] })
}

const out = []
for (const set of sets) {
  const loaded = await signalData(set.routes)
  const counted = withSignalCounts(set.routes, loaded.data)
  out.push({
    name: set.name,
    // The routes as counted, so the Swift side counts exactly the same lines.
    routes: set.routes.map((r) => ({
      geometry: r.geometry, intersections: r.intersections, limitedAccessSpansM: r.limitedAccessSpansM,
    })),
    missingTileIds: loaded.missingTileIds,
    primaryPointCount: loaded.data.primary.length,
    results: counted.routes.map((r, i) => ({
      signalCount: r.signalCount,
      signalCoverage: r.signalCoverage,
      signalIds: (counted.signalsByRouteId.get(set.routes[i].id) ?? []).map((s) => s.id),
    })),
  })
}
process.stdout.write(JSON.stringify({ generatedBy: 'native/scripts/signal-parity-reference.mjs', bundleDataDate: index.dataDate, sets: out }, null, 1) + '\n')
