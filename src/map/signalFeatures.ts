import type { RouteSignal } from '../core/index.ts'

export interface SignalFeature {
  type: 'Feature'
  properties: { id: string; name: string }
  geometry: { type: 'Point'; coordinates: number[] }
}

export interface SignalFeatureCollection {
  type: 'FeatureCollection'
  features: SignalFeature[]
}

/**
 * On-route signals as GeoJSON points for the map source, at the signal's own
 * position. A looping route can pass one signal twice; it is drawn once.
 */
export function signalFeatures(signals: readonly RouteSignal[]): SignalFeatureCollection {
  const seen = new Set<string>()
  const features: SignalFeature[] = []
  for (const s of signals) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    features.push({
      type: 'Feature',
      properties: { id: s.id, name: s.name ?? '' },
      geometry: { type: 'Point', coordinates: [s.position[0], s.position[1]] },
    })
  }
  return { type: 'FeatureCollection', features }
}
