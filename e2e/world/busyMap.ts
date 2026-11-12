// A busy map for design checks (#47): a dense street grid with major roads,
// parks, points of interest and traffic colours, drawn by mapbox-gl from inline
// GeoJSON, so the app can be photographed over something as cluttered as a real
// street map without a token, tiles or the network. Our own geometry and our own
// colours, loosely the kind of palette a day and a night street map use; it is
// not any product's style. No text labels: glyphs would need a font server.

type Palette = 'day' | 'night'

const COLORS: Record<Palette, Record<string, string>> = {
  day: { land: '#f2efe9', park: '#cfe8c8', water: '#aad3df', minor: '#ffffff', minorCase: '#d9d4cc', major: '#fcd581', majorCase: '#d9a441', poi: '#8a6dbf', building: '#e4ddd3' },
  night: { land: '#1b1f24', park: '#1f2d24', water: '#16263a', minor: '#2f353d', minorCase: '#14171b', major: '#4a4f57', majorCase: '#101215', poi: '#7d8794', building: '#252a31' },
}
const TRAFFIC = { heavy: '#d73027', slow: '#f39c12', free: '#2ecc71' }

/** The area of the e2e trip (Uptown Charlotte to Indian Land), with some margin. */
const WEST = -80.95
const EAST = -80.74
const SOUTH = 34.95
const NORTH = 35.3
const STEP = 0.0022

/** A deterministic pseudo-random number in [0, 1) for index `i`. */
const rand = (i: number) => {
  const x = Math.sin(i * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

type Feature = { type: 'Feature'; properties: Record<string, unknown>; geometry: unknown }
const line = (coords: number[][], properties: Record<string, unknown>): Feature => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: coords } })
const box = (w: number, s: number, e: number, n: number, properties: Record<string, unknown>): Feature => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
})

export function busyMapStyle(palette: Palette): object {
  const c = COLORS[palette]
  const streets: Feature[] = []
  let k = 0
  for (let lng = WEST; lng <= EAST; lng += STEP) streets.push(line([[lng, SOUTH], [lng, NORTH]], { major: ++k % 8 === 0 }))
  for (let lat = SOUTH; lat <= NORTH; lat += STEP) streets.push(line([[WEST, lat], [EAST, lat]], { major: ++k % 8 === 0 }))
  // A diagonal or two, as real cities have.
  streets.push(line([[WEST, SOUTH + 0.05], [EAST, NORTH - 0.02]], { major: true }))
  // Traffic on short stretches of some streets.
  const traffic: Feature[] = []
  for (let i = 0; i < 260; i++) {
    const lng = WEST + rand(i) * (EAST - WEST)
    const lat = SOUTH + rand(i + 1000) * (NORTH - SOUTH)
    const level = rand(i + 2000)
    const color = level < 0.3 ? TRAFFIC.heavy : level < 0.6 ? TRAFFIC.slow : TRAFFIC.free
    const len = 0.002 + rand(i + 3000) * 0.006
    traffic.push(line(i % 2 === 0 ? [[lng, lat], [lng + len, lat]] : [[lng, lat], [lng, lat + len]], { color }))
  }
  const areas: Feature[] = []
  for (let i = 0; i < 70; i++) {
    const w = WEST + rand(i + 4000) * (EAST - WEST)
    const s = SOUTH + rand(i + 5000) * (NORTH - SOUTH)
    areas.push(box(w, s, w + 0.002 + rand(i + 6000) * 0.006, s + 0.002 + rand(i + 7000) * 0.005, { kind: i % 9 === 0 ? 'water' : 'park' }))
  }
  for (let i = 0; i < 900; i++) {
    const w = WEST + rand(i + 8000) * (EAST - WEST)
    const s = SOUTH + rand(i + 9000) * (NORTH - SOUTH)
    areas.push(box(w + 0.0003, s + 0.0003, w + 0.0013, s + 0.0011, { kind: 'building' }))
  }
  const pois: Feature[] = []
  for (let i = 0; i < 1400; i++) {
    pois.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [WEST + rand(i + 10000) * (EAST - WEST), SOUTH + rand(i + 11000) * (NORTH - SOUTH)] } })
  }
  const geo = (features: Feature[]) => ({ type: 'geojson', data: { type: 'FeatureCollection', features } })
  return {
    version: 8,
    name: `e2e busy ${palette}`,
    sources: { streets: geo(streets), traffic: geo(traffic), areas: geo(areas), pois: geo(pois) },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': c.land } },
      { id: 'parks', type: 'fill', source: 'areas', filter: ['==', ['get', 'kind'], 'park'], paint: { 'fill-color': c.park } },
      { id: 'water', type: 'fill', source: 'areas', filter: ['==', ['get', 'kind'], 'water'], paint: { 'fill-color': c.water } },
      { id: 'buildings', type: 'fill', source: 'areas', filter: ['==', ['get', 'kind'], 'building'], paint: { 'fill-color': c.building } },
      { id: 'minor-case', type: 'line', source: 'streets', filter: ['!', ['get', 'major']], paint: { 'line-color': c.minorCase, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 16, 9] } },
      { id: 'minor', type: 'line', source: 'streets', filter: ['!', ['get', 'major']], paint: { 'line-color': c.minor, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 7] } },
      { id: 'major-case', type: 'line', source: 'streets', filter: ['get', 'major'], paint: { 'line-color': c.majorCase, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 14] } },
      { id: 'major', type: 'line', source: 'streets', filter: ['get', 'major'], paint: { 'line-color': c.major, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 11] } },
      { id: 'traffic', type: 'line', source: 'traffic', paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 5] } },
      { id: 'pois', type: 'circle', source: 'pois', paint: { 'circle-color': c.poi, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 16, 5], 'circle-stroke-color': c.land, 'circle-stroke-width': 1 } },
    ],
  }
}
