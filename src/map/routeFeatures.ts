import type { RouteCandidate } from '../core/index.ts'

export interface RouteFeature {
  type: 'Feature'
  properties: { id: string; selected: boolean }
  geometry: { type: 'LineString'; coordinates: number[][] }
}

export interface RouteFeatureCollection {
  type: 'FeatureCollection'
  features: RouteFeature[]
}

/** Routes as GeoJSON lines for the map source. `selected` drives the layer filters. */
export function routeFeatures(
  routes: readonly RouteCandidate[],
  selectedId: string | null,
): RouteFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: routes.map((r) => ({
      type: 'Feature',
      properties: { id: r.id, selected: r.id === selectedId },
      geometry: { type: 'LineString', coordinates: r.geometry.map(([lng, lat]) => [lng, lat]) },
    })),
  }
}
