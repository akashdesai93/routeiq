import { EMPTY_PLACE_BOOK, serializePlaceBook, setLastTrip } from '../src/core/index.ts'
import { PLACE_BOOK_KEY } from '../src/storage/placeBook.ts'
import { expect, standing, test, type App } from './harness.ts'
import { CAPITOL, STONE_MOUNTAIN } from './world/places.ts'
import { World, type LngLat } from './world/roads.ts'

// Where the driver really waits (#196, steps 1 and 2): during a live drive the phone
// measures each stop, tells a wait at a light from one elsewhere, and the Drives screen
// shows them. Kept on the device only, with no position.
//
// The trip is outside the bundled NC/SC tiles, so the lights are the ones this scenario
// gives Overpass: two, placed on the made-up Main Corridor's corners. Overpass answers every
// tile, so the light data is complete and a stop away from a light is "not at a light".

const LOG_KEY = 'routeiq.drives.v1'
/** Anything that looks like a coordinate: a number with four or more decimals. */
const COORDINATE = /-?\d{1,3}\.\d{4,}/

function metersBetween(a: LngLat, b: LngLat): number {
  const rad = Math.PI / 180
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad)
  const y = (b[1] - a[1]) * rad
  return Math.hypot(x, y) * 6_371_008.8
}

/** The Georgia trip on the device, and Overpass answering every tile with lights at Main Corridor's 2nd and 3rd corners. */
function tripWithLights(app: App): { storage: Record<string, string>; firstLightM: number } {
  const corners = new World(STONE_MOUNTAIN.position as LngLat, CAPITOL.position as LngLat).cornersOf('A')
  const lights = [corners[1]!, corners[2]!]
  app.outside.overpass = (query) => {
    const box = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/.exec(query)
    if (box === null) return { status: 400 }
    const [south, west, north, east] = box.slice(1).map(Number) as [number, number, number, number]
    const elements = lights
      .filter(([lng, lat]) => lat >= south && lat <= north && lng >= west && lng <= east)
      .map(([lng, lat], i) => ({ type: 'node', id: 700 + i, lat, lon: lng, tags: { highway: 'traffic_signals' } }))
    return { status: 200, body: { version: 0.6, generator: 'e2e', elements } }
  }
  const book = setLastTrip(EMPTY_PLACE_BOOK, { origin: STONE_MOUNTAIN, destination: CAPITOL })
  return { storage: { [PLACE_BOOK_KEY]: JSON.stringify(serializePlaceBook(book)) }, firstLightM: metersBetween(corners[0]!, corners[1]!) }
}

test('after a drive, the Drives screen shows where I sat at lights, and the waits add up to the time I stood still', async ({ app, page }) => {
  const { storage, firstLightM } = tripWithLights(app)
  await app.open({ fakeClock: true, storage })
  await app.routesReady()
  await expect(page.locator('ol.routes > li').first().locator('.route-signals')).toHaveText('2 signals')

  // 20 s held up mid-block (no light near), then a minute at the first light, stopped just before it.
  const log = await app.drive({
    speedMps: standing([
      { atM: firstLightM / 2, forSec: 20 },
      { atM: firstLightM - 10, forSec: 60 },
    ]),
  })
  expect(log.arrived).toBe(true)
  await page.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: /^Drives/ }).click()
  const drive = page.getByRole('list', { name: 'Past drives' }).getByRole('listitem').first()
  const stops = drive.getByLabel('Stops')
  // The two stops, and nothing else: 20 s + 60 s.
  await expect(stops).toContainText('Stopped 1 min 20 s (2 stops)')
  await expect(stops).toContainText('At lights: 1 min at 1 light')
  await expect(stops).toContainText(/Worst light: 1 min, \d+\.\d mi in/)
  // Moving time is the rest of the drive.
  const took = Number(/Took (\d+) min/.exec((await drive.textContent())!)![1])
  const moving = /Moving (\d+) min/.exec((await stops.textContent())!)
  expect(moving).not.toBeNull()
  expect(Math.abs(Number(moving![1]) - (took - 80 / 60))).toBeLessThanOrEqual(1)
  // Predicted against actual on the streets; the made-up roads have no freeway.
  await expect(stops).toContainText(/Streets: predicted \d+ min · took \d+ min/)
  await expect(stops).not.toContainText('Freeway')
  await app.snap('the Drives screen: stops, the time at lights, and the worst light')

  // Kept on the device with no position: seconds and meters only.
  const stored = await page.evaluate((key) => localStorage.getItem(key), LOG_KEY)
  expect(stored).not.toMatch(COORDINATE)
  const record = (JSON.parse(stored!) as { drives: { stops: { list: { place: string; durationSec: number }[]; stoppedSec: number } }[] }).drives[0]!
  expect(record.stops.list.map((s) => [s.place, s.durationSec])).toEqual([
    ['none', 20],
    ['light', 60],
  ])
  expect(record.stops.stoppedSec).toBe(80)

  // Export: the stop columns at the end of the row.
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByLabel('Drive log as CSV')).toHaveValue(/,stopped_min,light_stops,light_wait_min\n.*,1\.3,1,1\.0$/)
})

test('where light data is missing, a wait is never shown as "not at a light"', async ({ app, page }) => {
  const { storage, firstLightM } = tripWithLights(app)
  // Overpass is busy for the western part of the trip: the light data is partial.
  const answer = app.outside.overpass!
  app.outside.overpass = (query) => {
    const box = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/.exec(query)
    return box !== null && Number(box[2]) < -84.3 ? { status: 504 } : answer(query)
  }
  await app.open({ fakeClock: true, storage })
  await app.routesReady()
  await expect(page.locator('ol.routes > li').first().locator('.route-signals')).toHaveText(/^≥ \d+ signals? \(partial\)$/)

  // 30 s held up mid-block, then End.
  await app.drive({ speedMps: standing([{ atM: firstLightM / 2, forSec: 30 }]), maxSec: 160 })
  await page.getByRole('button', { name: 'End' }).click()

  await page.getByRole('button', { name: /^Drives/ }).click()
  const stops = page.getByRole('list', { name: 'Past drives' }).getByRole('listitem').first().getByLabel('Stops')
  await expect(stops).toContainText('Stopped 30 s (1 stop)')
  await expect(stops).toContainText('At lights: unknown · 1 stop where lights are unknown')
  await expect(stops).not.toContainText('At lights: none')
  await app.snap('the Drives screen: a wait where the light data is partial')
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByLabel('Drive log as CSV')).toHaveValue(/,0\.5,,$/)
})
