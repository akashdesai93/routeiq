import type { Place } from '../../src/core/index.ts'

// Trip ends outside North and South Carolina, where no signal data ships with the app and
// every light comes from Overpass, which a scenario answers with lights it places on the
// made-up roads. Public landmarks in Georgia, shared so no scenario repeats a coordinate.

export const STONE_MOUNTAIN: Place = { id: 'e2e:stone-mountain', label: 'Stone Mountain Park', position: [-84.1455, 33.8053] }
export const CAPITOL: Place = { id: 'e2e:ga-capitol', label: 'Georgia State Capitol', position: [-84.388, 33.749] }
