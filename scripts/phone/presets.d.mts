// Types for presets.mjs, so the tests can import it.

import type { LngLat } from './make-gpx.mjs'

export const PRESETS: Readonly<Record<string, { readonly about: string; readonly waypoints: readonly LngLat[] }>>
export const PRESET_LEAVES_ROUTE_AT_M: Readonly<Record<'wrong-turn' | 'turn-around', number>>
