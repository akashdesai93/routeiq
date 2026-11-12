import type { Page } from '@playwright/test'
import { expect, test, type App } from './harness.ts'
import { busyMapStyle } from './world/busyMap.ts'

// The drive map by day and by night (#145, findings 1-4 of docs/design/map-check.md), over the
// busy map of our own (e2e/world/busyMap.ts): the map style follows the phone's appearance, the
// route ahead is drawn so it reads on that map, and while driving the base map's points of
// interest and traffic are off (amber is the only news colour; RouteIQ shows its own slow stretch).

/** The colours of the busy map's traffic lines and its points of interest (busyMap.ts). */
const TRAFFIC = ['#d73027', '#f39c12', '#2ecc71']
const NIGHT_POI = '#7d8794'
const DAY_POI = '#8a6dbf'

/**
 * How many pixels of the map between the turn card and the sheet are within `tolerance` of each
 * colour: what the driver sees of the map, without the cards' own text.
 */
async function mapPixels(page: Page, colours: readonly string[], tolerance = 6): Promise<number[]> {
  const top = (await page.locator('.live-top').boundingBox())!
  const sheet = (await page.locator('.live-bottom').boundingBox())!
  const clip = { x: 0, y: top.y + top.height + 4, width: page.viewportSize()!.width, height: sheet.y - (top.y + top.height) - 40 }
  const png = await page.screenshot({ clip })
  return page.evaluate(
    async ([data, wanted, tol]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${data}`
      await img.decode()
      const canvas = new OffscreenCanvas(img.width, img.height)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const px = ctx.getImageData(0, 0, img.width, img.height).data
      const rgb = wanted.map((h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)))
      const counts = rgb.map(() => 0)
      for (let i = 0; i < px.length; i += 4) {
        rgb.forEach(([r, g, b], k) => {
          if (Math.abs(px[i]! - r!) <= tol && Math.abs(px[i + 1]! - g!) <= tol && Math.abs(px[i + 2]! - b!) <= tol) counts[k]!++
        })
      }
      return counts
    },
    [png.toString('base64'), colours, tolerance] as const,
  )
}

/** Drives the e2e trip for a minute and looks at the map once the car is moving. */
async function lookWhileDriving(app: App, look: () => Promise<void>) {
  let looked = false
  await app.drive({
    maxSec: 64,
    lookAtSec: [
      {
        atSec: 60,
        look: async () => {
          await look()
          looked = true
        },
      },
    ],
  })
  expect(looked).toBe(true)
}

function styleRequests(page: Page): string[] {
  const asked: string[] = []
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (url.pathname.startsWith('/styles/v1/')) asked.push(url.pathname)
  })
  return asked
}

test.describe('at night', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' })

  test('at night the drive map is a night map, the route ahead is a light line on a dark casing, and no traffic or points of interest are drawn', async ({ app, page }) => {
    const asked = styleRequests(page)
    app.outside.mapStyle = busyMapStyle('night')
    await app.open({ fakeClock: true })
    await app.routesReady()
    expect(asked.at(-1)).toMatch(/navigation-night-v1/)
    // On the trip screen the base map is whole: points of interest help when choosing where to go.
    await lookWhileDriving(app, async () => {
      await page.clock.runFor(50)
      await app.snap('night: driving over a night map')
      const [lightCore, poi, ...traffic] = await mapPixels(page, ['#f2f4f6', NIGHT_POI, ...TRAFFIC])
      // Tighter for the day's core: the night map's own major-road casing (#101215) is 6 away from it.
      // What is left of #0a0c0f is the car's outline ring, which is the same by day and by night.
      const [darkCore] = await mapPixels(page, ['#0a0c0f'], 3)
      // The route ahead reads on the dark land: a light core (#f2f4f6), not the day's black one.
      expect(lightCore, 'light route core pixels').toBeGreaterThan(2000)
      expect(darkCore, 'black (day) route core pixels').toBeLessThan(lightCore! / 2)
      // Nothing orange next to amber, and no clutter behind the cards.
      expect(traffic, 'traffic pixels (red, orange, green)').toEqual([0, 0, 0])
      expect(poi, 'points of interest').toBeLessThan(20)
      // The cards keep their edge against the night map: a lighter hairline (3.5:1 on the land).
      const edge = await page.locator('.live-top').evaluate((el) => getComputedStyle(el).borderTopColor)
      expect(edge).toBe('rgb(107, 115, 126)')
    })
  })
})

test.describe('by day', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' })

  test('by day the drive map is the day map and the route ahead is black on a white casing', async ({ app, page }) => {
    const asked = styleRequests(page)
    app.outside.mapStyle = busyMapStyle('day')
    await app.open({ fakeClock: true })
    await app.routesReady()
    expect(asked.at(-1)).toMatch(/streets-v12/)
    await lookWhileDriving(app, async () => {
      await page.clock.runFor(50)
      await app.snap('day: driving over a day map')
      // (Not counted by day: a near-white core, which the white streets' anti-aliased edges also give.)
      const [darkCore, poi, ...traffic] = await mapPixels(page, ['#0a0c0f', DAY_POI, ...TRAFFIC])
      expect(darkCore, 'black route core pixels').toBeGreaterThan(400)
      expect(traffic, 'traffic pixels (red, orange, green)').toEqual([0, 0, 0])
      expect(poi, 'points of interest').toBeLessThan(20)
      const edge = await page.locator('.live-top').evaluate((el) => getComputedStyle(el).borderTopColor)
      expect(edge).toBe('rgb(44, 49, 56)')
    })
  })
})
