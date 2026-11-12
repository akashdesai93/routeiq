import type { Page } from '@playwright/test'
import { expect, test } from './harness.ts'

// Add to Home Screen and the offline shell (#9). After one visit with a connection the app
// opens with no signal and says it needs one for routes; it never keeps a Mapbox answer or
// anything with the token in its address. The iPhone shell gets no service worker at all.

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

/** Every address the service worker has stored, in every cache. */
async function stored(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url)
    }
    return urls
  })
}

test('after one visit it opens with no signal, says routes need a connection, and never keeps a Mapbox answer', async ({ app, page, context }) => {
  await app.open()
  await app.routesReady()
  // The worker has taken over this page and kept the app's own files.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15_000 })
  await expect.poll(async () => (await stored(page)).filter((u) => /\/assets\/.+\.js$/.test(u)).length, { timeout: 15_000 }).toBeGreaterThan(0)
  expect(app.directionsRequests).toBeGreaterThan(0)

  const kept = await stored(page)
  expect(kept.filter((u) => !u.startsWith(new URL(page.url()).origin)), 'only files of this site are kept').toEqual([])
  expect(kept.filter((u) => /mapbox\.com|access_token|pk\.test/.test(u)), 'no Mapbox answer and no token').toEqual([])
  expect(kept).toContain(new URL('/', page.url()).href)
  await expect(page.locator('.offline-note')).toHaveCount(0)

  // No signal at all: the page itself and every file of this site are refused by the network.
  await context.setOffline(true)
  await page.reload()
  await expect(page.locator('.side')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('No connection. RouteIQ opens without one, but finding routes and traffic needs it.')).toBeVisible()
  // The app's own look came along: the styles, and the bundled fonts (fetched before the worker
  // took over, so kept only because the page named them to it), not a browser error page.
  expect(await page.locator('.app').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(5, 6, 7)')
  await page.evaluate(() => document.fonts.ready)
  expect(await page.evaluate(() => document.fonts.check('600 16px Inter') && [...document.fonts].some((f) => f.family.includes('Inter') && f.status === 'loaded'))).toBe(true)
  // Opened by its other address too: the same stored page.
  await page.goto(new URL('/index.html', page.url()).href)
  await expect(page.locator('.offline-note')).toBeVisible({ timeout: 15_000 })
  await app.snap('opened with no signal')

  // The signal comes back: the note goes by itself.
  await context.setOffline(false)
  await expect(page.locator('.offline-note')).toHaveCount(0)
  // Nothing from Mapbox was kept on the way either.
  expect((await stored(page)).filter((u) => /mapbox\.com|access_token|pk\.test/.test(u))).toEqual([])
})

test('on the Home Screen it is RouteIQ with its own icon, and says a locked iPhone stops a web app', async ({ app, page }) => {
  await app.open()
  await app.routesReady()
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href')
  const manifestUrl = new URL(manifestHref!, page.url())
  const manifest = (await (await page.request.get(manifestUrl.href)).json()) as {
    name: string
    display: string
    start_url: string
    icons: { src: string; sizes: string; purpose: string }[]
  }
  expect(manifest.name).toBe('RouteIQ')
  expect(manifest.display).toBe('standalone')
  // Each icon is there, at the size it claims: a 192 and a 512, and one Android may crop to a circle.
  expect(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`).sort()).toEqual(['192x192 any', '512x512 any', '512x512 maskable'])
  for (const icon of [...manifest.icons, { src: await page.locator('link[rel="apple-touch-icon"]').getAttribute('href'), sizes: '180x180' }]) {
    const url = new URL(icon.src!, manifestUrl).href
    const size = await page.evaluate(async (src) => {
      const img = new Image()
      img.src = src
      await img.decode()
      return `${img.naturalWidth}x${img.naturalHeight}`
    }, url)
    expect(size, url).toBe(icon.sizes)
  }
  // It does not promise what a home-screen web app cannot do on a locked iPhone.
  await expect(page.getByText('iPhone stops a web app’s GPS when the phone locks')).toBeVisible()
  await page.getByText('use the RouteIQ iPhone app').scrollIntoViewIfNeeded()
  await app.snap('the Home Screen note under Start drive')
})

test('in the iPhone app no service worker is registered and the web-app note is not shown', async ({ app, page }) => {
  await app.open({ shell: true })
  await app.routesReady()
  await page.waitForFunction(() => document.readyState === 'complete')
  // Give a registration that should not happen the time it would take.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)))
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0)
  await expect(page.locator('.home-screen-note')).toHaveCount(0)
})
