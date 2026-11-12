import { describe, expect, it } from 'vitest'
import { DRIVE_HIDDEN_LAYERS, MAP_THEMES } from '../src/map/mapTheme.ts'

// Which base-map layers are switched off while following the car (#145, map-check findings 3, 4).
// The native app takes the same rule, so it is pinned here on real Mapbox style layer ids.
describe('the drive map hides points of interest, transit and traffic, and nothing else', () => {
  it('hides the base map POI, transit and traffic layers', () => {
    for (const id of ['poi-label', 'transit-label', 'road-traffic', 'traffic', 'traffic-tunnel', 'pois']) {
      expect(DRIVE_HIDDEN_LAYERS.test(id), id).toBe(true)
    }
  })

  it('keeps the roads, places and water, and every layer of the app itself', () => {
    const kept = ['road-primary', 'road-street', 'road-label', 'place-label', 'water', 'land', 'building', 'bridge-motorway-trunk']
    const ours = ['routes-hit', 'routes-alt', 'routes-selected-edge', 'routes-selected', 'route-signals', 'drive-route', 'drive-route-case', 'drive-turn', 'drive-car']
    for (const id of [...kept, ...ours]) expect(DRIVE_HIDDEN_LAYERS.test(id), id).toBe(false)
  })

  it('draws the route ahead light on dark at night and dark on light by day', () => {
    expect(MAP_THEMES.day).toMatchObject({ routeCore: '#0a0c0f', routeCase: '#ffffff' })
    expect(MAP_THEMES.night).toMatchObject({ routeCore: '#f2f4f6', routeCase: '#050607' })
  })
})
