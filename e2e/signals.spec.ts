import { EMPTY_PLACE_BOOK, serializePlaceBook, setLastTrip, type Place } from '../src/core/index.ts'
import { PLACE_BOOK_KEY } from '../src/storage/placeBook.ts'
import { expect, test } from './harness.ts'
import { World, type LngLat } from './world/roads.ts'

// Light counts outside North and South Carolina, where no signal data ships
// with the app and every tile has to come from Overpass.

// Public landmarks in Georgia, well outside the bundled NC/SC tiles.
const STONE_MOUNTAIN: Place = { id: 'e2e:stone-mountain', label: 'Stone Mountain Park', position: [-84.1455, 33.8053] }
const CAPITOL: Place = { id: 'e2e:ga-capitol', label: 'Georgia State Capitol', position: [-84.388, 33.749] }

test('a route outside NC/SC shows a partial light count, never 0, and still ranks by time', async ({ app, page }) => {
  // The device's last trip was in Georgia, so the app opens with it.
  const book = setLastTrip(EMPTY_PLACE_BOOK, { origin: STONE_MOUNTAIN, destination: CAPITOL })
  // Overpass answers for the eastern part of the trip and is busy for the western part.
  // The two signals it knows are on the made-up Main Corridor, at its first two corners.
  const corridor = new World(STONE_MOUNTAIN.position as LngLat, CAPITOL.position as LngLat).cornersOf('A')
  const signals = [corridor[1]!, corridor[2]!]
  app.outside.overpass = (query) => {
    const box = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/.exec(query)
    if (box === null) return { status: 400 }
    const [south, west, north, east] = box.slice(1).map(Number) as [number, number, number, number]
    if (west < -84.3) return { status: 504 }
    const elements = signals
      .filter(([lng, lat]) => lat >= south && lat <= north && lng >= west && lng <= east)
      .map(([lng, lat], i) => ({ type: 'node', id: 900 + i, lat, lon: lng, tags: { highway: 'traffic_signals' } }))
    return { status: 200, body: { version: 0.6, generator: 'e2e', elements } }
  }
  await app.open({ storage: { [PLACE_BOOK_KEY]: JSON.stringify(serializePlaceBook(book)) } })
  await expect(page.getByRole('combobox', { name: 'Destination' })).toHaveValue('Georgia State Capitol')
  await app.routesReady()
  await app.snap('a Georgia trip: partial counts')

  const counts = await page.locator('.route-signals').allTextContents()
  expect(counts).toHaveLength(3)
  for (const count of counts) {
    // A lower bound or unknown: never a plain number, never zero.
    expect(count).toMatch(/^(≥ \d+ signals? \(partial\)|Signals: unknown)$/)
    expect(count).not.toMatch(/(^|\D)0 signals/)
  }
  // At least one route shows the lower bound the answered tiles give.
  expect(counts.some((c) => c.startsWith('≥ '))).toBe(true)
  // A missing count changes nothing in the ranking: fastest first.
  const minutes = (await page.locator('.route-eta').allTextContents()).map((t) => Number.parseInt(t, 10))
  expect(minutes).toEqual([...minutes].sort((a, b) => a - b))
  await expect(page.locator('ol.routes > li').first().locator('.route-badge')).toHaveText('Recommended')
  // OpenStreetMap is the only signal data credited. The City of Charlotte list was removed (#13):
  // the harness no longer answers its server, so a request to it would fail the scenario.
  await expect(page.getByText('© OpenStreetMap contributors').first()).toBeVisible()
  await expect(page.getByText('City of Charlotte')).toHaveCount(0)
})
