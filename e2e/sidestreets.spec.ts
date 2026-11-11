import { expect, test } from './harness.ts'
import { JAM_WHERE_ALL_THREE_SHARE } from './world/traffic.ts'

// Side-street probing on the plan screen (PLAN step 11b). Mapbox offers three
// routes at most; the made-up network here also has Parallel Street (S), which
// Mapbox never offers. After the three routes are on screen the app asks for
// the trip again through a point beside the fastest one, finds S, and ranks it
// like any other route: on ETA.

const SIDE = 'via side streets'

test('when a side street saves time, it is offered and wins', async ({ app, page }) => {
  // A jam where all three of Mapbox's routes run; Parallel Street goes past it.
  app.outside.sideStreet = true
  app.outside.traffic = JAM_WHERE_ALL_THREE_SHARE
  await app.open()
  await expect(page.locator('.route-source', { hasText: SIDE })).toBeVisible({ timeout: 15_000 })
  await app.routesReady()
  await app.snap('the side street, found by a probe, is the fastest and recommended')

  // Mapbox's own answer did not have it.
  expect(app.answers[0]!.routes.map((r) => r.name).sort()).toEqual(['A', 'B', 'C'])
  // Two probes (the budget): one found S, the other snapped back onto A and was dropped as a repeat.
  expect(app.probes.map((p) => p.road).sort()).toEqual(['A', 'S'])

  const routes = page.locator('ol.routes > li')
  await expect(routes).toHaveCount(4)
  await expect(page.locator('.route-source')).toHaveCount(1)
  await expect(routes.first()).toContainText('Recommended')
  await expect(routes.first()).toContainText(SIDE)
  await expect(routes.first()).toContainText('Fastest right now')
  await expect(routes.first().getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  const minutes = (await page.locator('.route-eta').allTextContents()).map((t) => Number.parseInt(t, 10))
  expect(minutes).toEqual([...minutes].sort((a, b) => a - b))
})

test('when a side street is slower, it is shown but not recommended', async ({ app, page }) => {
  // Free flow: Parallel Street is the slowest way.
  app.outside.sideStreet = true
  await app.open()
  await expect(page.locator('.route-source', { hasText: SIDE })).toBeVisible({ timeout: 15_000 })
  await app.routesReady()
  await app.snap('the side street is offered, last, and the main corridor stays recommended')

  const routes = page.locator('ol.routes > li')
  await expect(routes).toHaveCount(4)
  await expect(routes.first()).toContainText('Recommended')
  await expect(routes.first()).not.toContainText(SIDE)
  await expect(routes.last()).toContainText(SIDE)
  await expect(routes.last()).toContainText('slower than the fastest')
})

test('a probe that only finds a route already on screen adds nothing', async ({ app, page }) => {
  // No side street in this world: every probe snaps back onto one of Mapbox's routes.
  await app.open()
  await app.routesReady()
  await expect.poll(() => app.probes.length).toBe(2)
  await app.routesReady()
  expect(app.probes.every((p) => p.road !== null && p.road !== 'S')).toBe(true)
  await expect(page.locator('ol.routes > li')).toHaveCount(3)
  await expect(page.locator('.route-source')).toHaveCount(0)
})
