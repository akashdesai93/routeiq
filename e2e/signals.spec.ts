import { EMPTY_PLACE_BOOK, serializePlaceBook, setLastTrip, type Place } from '../src/core/index.ts'
import { PLACE_BOOK_KEY } from '../src/storage/placeBook.ts'
import { expect, test, type App } from './harness.ts'
import { World, type LngLat } from './world/roads.ts'

// Light counts outside North and South Carolina, where no signal data ships
// with the app and every tile has to come from Overpass.

// Public landmarks in Georgia, well outside the bundled NC/SC tiles.
const STONE_MOUNTAIN: Place = { id: 'e2e:stone-mountain', label: 'Stone Mountain Park', position: [-84.1455, 33.8053] }
const CAPITOL: Place = { id: 'e2e:ga-capitol', label: 'Georgia State Capitol', position: [-84.388, 33.749] }

/** The device's last trip was in Georgia, and Overpass knows only part of it: what to open the app with. */
function georgiaTrip(app: App): Record<string, string> {
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
  return { [PLACE_BOOK_KEY]: JSON.stringify(serializePlaceBook(book)) }
}

test('a route outside NC/SC shows a partial light count, never 0, and still ranks by time', async ({ app, page }) => {
  await app.open({ storage: georgiaTrip(app) })
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

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

  test('picking a route where light data is missing: a lower bound that says so, and the delta row never compares lights', async ({ app, page }) => {
    await app.open({ storage: georgiaTrip(app) })
    await app.routesReady()
    const cards = page.locator('ol.routes > li')
    await expect(cards).toHaveCount(3)
    // Each card: a lower bound or "unknown", and under it in words what is missing. Never 0.
    for (const card of await cards.all()) {
      const count = (await card.locator('.route-signals').textContent())!
      expect(count).toMatch(/^(≥ [1-9]\d* signals? \(partial\)|Signals: unknown)$/)
      await expect(card.locator('.route-signal-note')).toHaveText(
        count.startsWith('≥') ? 'Signal data for part of this route is missing, so this is a lower bound.' : 'Signal data for this route could not be loaded.',
      )
    }
    // Minutes and miles are compared; lights are not, and the row says so instead of a number.
    const delta = page.getByRole('group', { name: 'Route 1 against Route 2' })
    await expect(delta.locator('[data-delta="lights"]')).toHaveText("Lights: can't compare")
    await expect(delta.locator('[data-delta="time"]')).toHaveText(/^(\u2212\d+|0) min$/)
    await delta.scrollIntoViewIfNeeded()
    await app.snap('partial and unknown light counts on the route cards, and the delta row')
  })

  test('driving where light data is missing, More shows a lower bound that says so, never 0', async ({ app, page }) => {
    await app.open({ fakeClock: true, storage: georgiaTrip(app) })
    await app.routesReady()
    const lights = page.getByLabel('Live drive').locator('[data-tile="lights"]')
    await app.drive({
      maxSec: 40,
      lookAtSec: [
        {
          atSec: 30,
          look: async () => {
            await page.getByRole('button', { name: 'More' }).click()
            await page.clock.runFor(50)
            // Part of this route has no light data: what is known is a lower bound, and the tile says so.
            await expect(lights).toHaveText(/^Lights on route≥ [1-9]\d* data missing$/)
            await app.snap('More on a route with missing light data: a lower bound')
          },
        },
      ],
    })
  })
})
