import { expect, test } from './harness.ts'

// Opening the app: Mapbox GL JS (about 1.35 MB) comes after the first screen (#97), so on a
// slow phone the trip and its routes are on screen while the map is still on its way.
// The map's file is held back (or refused) here to show that nothing else waits for it.

/** The Mapbox GL JS chunk of the build (vite.config.ts names it mapbox-gl-<hash>.js). */
const MAPBOX_CHUNK = /\/assets\/mapbox-gl-[^/]+\.js$/

test('on a slow phone, my trip and its routes show before the map has loaded, and the map fills in after', async ({ app, page }) => {
  const held: string[] = []
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  await page.route(MAPBOX_CHUNK, async (route) => {
    held.push(route.request().url())
    await released
    await route.fallback()
  })
  await app.open()
  await app.routesReady()

  // The routes are ranked and counted while the map's code has not even arrived.
  await expect(page.locator('ol.routes > li')).toHaveCount(3)
  await expect(page.getByRole('combobox', { name: 'Destination' })).toBeVisible()
  expect(held).toHaveLength(1)
  await expect(page.locator('canvas.mapboxgl-canvas')).toHaveCount(0)
  // Its place is kept, so nothing jumps when it arrives.
  await expect(page.locator('[data-testid="map"]')).toBeVisible()
  await app.snap('the routes are ready while the map is still loading')

  release()
  await expect(page.locator('canvas.mapboxgl-canvas')).toBeVisible()
  await expect(page.locator('ol.routes > li')).toHaveCount(3)
  await app.snap('the map has filled in')
})

test('when the map cannot load, I still get my routes and the drive talks me there', async ({ app, page }) => {
  await page.route(MAPBOX_CHUNK, (route) => route.abort())
  await app.open({ fakeClock: true })
  await app.routesReady()
  await expect(page.getByRole('alert')).toContainText('The map could not be loaded')
  await expect(page.locator('ol.routes > li')).toHaveCount(3)
  await app.snap('no map, but the routes are there')

  const log = await app.drive({ snapAtSec: [60] })
  expect(log.arrived).toBe(true)
  const spoken = await app.spoken()
  expect(spoken[0]).toBe('RouteIQ started')
  expect(spoken.at(-1)).toBe('You have arrived. Trip time 17 minutes.')
})
