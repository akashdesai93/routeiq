import type { Locator, Page } from '@playwright/test'
import { expect, test } from './harness.ts'
import { NO_TOKEN_PORT } from './ports.ts'
import { JAM_WHERE_ALL_THREE_SHARE } from './world/traffic.ts'

// The plan and route-picking screens in the approved design (#85; design
// merged-1-plan, merged-2-pick-a-route, merged-signal-states): dark, phone
// first, the time leading each route, one Recommended, the delta row
// (−8 min · −2 lights · −3 mi) and a white Start. Light counts that are not
// whole are never 0 and never compared.

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

const MINUS = '−'

/** "−8" → -8, "+2" → 2, "0" → 0. */
const signed = (text: string) => Number(text.replace(MINUS, '-'))

/** Every visible button in `scope` is at least 44 px high. */
async function allTappable(scope: Locator) {
  for (const button of await scope.getByRole('button').all()) {
    if (await button.isVisible()) expect((await button.boundingBox())!.height, await button.innerText()).toBeGreaterThanOrEqual(44)
  }
}

async function background(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor)
}

test('on a phone, the routes read time first, one is Recommended, and the delta row says what it gains over the next', async ({ app, page }) => {
  await app.open()
  await app.routesReady()
  await app.snap('pick a route on a phone')

  // Edge to edge on an iPhone (viewport-fit=cover); the app pads itself with the safe-area insets,
  // which headless Chromium cannot emulate (they are 0 here).
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/)
  // Dark, on every screen: black glass, not the old white page.
  expect(await background(page, '.app')).toBe('rgb(5, 6, 7)')
  // The map first, the trip and the routes in a sheet under it.
  const [map, plan] = [await page.getByTestId('map').boundingBox(), await page.getByLabel('Plan a trip').boundingBox()]
  expect(map!.y).toBeLessThan(plan!.y)

  const cards = page.locator('ol.routes > li')
  await expect(cards).toHaveCount(3)
  await expect(cards.first().locator('.route-badge')).toHaveText('Recommended')
  // Time leads: the largest type on the card, left of the name.
  const eta = cards.first().locator('.route-eta')
  const name = cards.first().locator('.route-name')
  expect((await eta.boundingBox())!.x).toBeLessThan((await name.boundingBox())!.x)
  const etaSize = await eta.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
  expect(etaSize).toBeGreaterThanOrEqual(48)

  // The delta row: Route 1 against Route 2, figures that add up to the two cards.
  const minutes = (await page.locator('.route-eta').allTextContents()).map((t) => Number.parseInt(t, 10))
  const signals = (await page.locator('.route-signals').allTextContents()).map((t) => Number.parseInt(t, 10))
  const miles = (await page.locator('.route-distance').allTextContents()).map((t) => Number.parseFloat(t))
  const delta = page.getByRole('group', { name: 'Route 1 against Route 2' })
  const time = (await delta.locator('[data-delta="time"]').textContent())!
  const lights = (await delta.locator('[data-delta="lights"]').textContent())!
  const distance = (await delta.locator('[data-delta="distance"]').textContent())!
  expect(time).toMatch(new RegExp(`^(${MINUS}\\d+|0) min$`))
  expect(Math.abs(signed(time.split(' ')[0]!) - (minutes[0]! - minutes[1]!))).toBeLessThanOrEqual(1)
  // Full counts on both: the difference in lights, signed.
  expect(lights).toMatch(new RegExp(`^([${MINUS}+]\\d+|0) lights?$`))
  expect(signed(lights.split(' ')[0]!)).toBe(signals[0]! - signals[1]!)
  // Each card rounds its miles (to whole ones from 10 up), the row the exact difference: within one.
  expect(distance).toMatch(new RegExp(`^([${MINUS}+][\\d.]+|0) mi$`))
  expect(Math.abs(signed(distance.split(' ')[0]!) - (miles[0]! - miles[1]!))).toBeLessThanOrEqual(1)

  // One white Start, large: the only filled button.
  const start = page.getByRole('button', { name: 'Start drive' })
  expect(await start.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(242, 244, 246)')
  expect((await start.boundingBox())!.height).toBeGreaterThanOrEqual(56)
  await expect(page.getByText('Switches by itself if a faster route holds up')).toBeVisible()
  await allTappable(page.getByLabel('Routes'))
  await allTappable(page.getByLabel('Plan a trip'))
  await start.scrollIntoViewIfNeeded()
  await app.snap('the delta row and Start')
})

test('a side street that wins carries its tag beside Recommended, on the time-first card', async ({ app, page }) => {
  app.outside.sideStreet = true
  app.outside.traffic = JAM_WHERE_ALL_THREE_SHARE
  await app.open()
  await expect(page.locator('.route-source', { hasText: 'via side streets' })).toBeVisible({ timeout: 15_000 })
  await app.routesReady()
  const first = page.locator('ol.routes > li').first()
  await expect(first.locator('.route-badge')).toHaveText('Recommended')
  await expect(first.locator('.route-source')).toHaveText('via side streets')
  // The tag is a tag: outlined, not the filled badge.
  expect(await first.locator('.route-source').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
    await first.locator('.route-badge').evaluate((el) => getComputedStyle(el).backgroundColor),
  )
  await first.scrollIntoViewIfNeeded()
  await app.snap('the side street, recommended, with its tag')
})

test('in the iPhone app the token screen is dark and the token and Drive diagnostics stay one tap away', async ({ app, page }) => {
  await app.open({ shell: true, path: `http://localhost:${NO_TOKEN_PORT}/` })
  await expect(page.getByText('Paste your Mapbox public token')).toBeVisible()
  expect(await background(page, '.app')).toBe('rgb(5, 6, 7)')
  await allTappable(page.locator('.token-screen'))
  await app.snap('the token screen')

  await page.getByLabel('Paste your Mapbox public token').fill('pk.test')
  await page.getByRole('button', { name: 'Save token' }).click()
  await app.routesReady()
  const bar = page.locator('.bar')
  await expect(bar.getByRole('button', { name: 'Change token' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Drive diagnostics' })).toBeVisible()
  await allTappable(bar)
  await bar.getByRole('button', { name: 'Drive diagnostics' }).click()
  await expect(page.getByRole('button', { name: 'Drive diagnostics' }).first()).toHaveAttribute('aria-expanded', 'true')
  await app.snap('the trip in the iPhone app, Drive diagnostics open')
})
