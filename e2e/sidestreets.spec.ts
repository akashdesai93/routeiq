import type { Page } from '@playwright/test'
import { expect, INDIAN_LAND, test, UPTOWN } from './harness.ts'
import { JAM_WHERE_ALL_THREE_SHARE } from './world/traffic.ts'

// Side-street probing on the plan screen (PLAN step 11b). Mapbox offers three
// routes at most; the made-up network here also has Parallel Street (S), which
// Mapbox never offers. After the three routes are on screen the app asks for
// the trip again through a point beside the fastest one, finds S, and ranks it
// like any other route: on ETA.

const SIDE = 'via side streets'
const OFF_ROUTE = 'You are off the route. Finding a new one.'
/** The via may move 250 m at most (DEFAULT_PROBE_OPTIONS.viaRadiusM); the ends may move as far as they must. */
const RADIUSES = 'unlimited;250;unlimited'
const NOTICE = /^Faster route found via side streets, saves (\d+ min|under a minute)\.$/

/** Long enough for a probe sent late (after another debounce) to have gone out. */
const LATE_MS = 2500

/** Records whether any route not found by a probe ever shows "Counting signals…" again from now on. */
async function watchForRecount(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __recounted: boolean }
    w.__recounted = false
    const look = () => {
      for (const row of document.querySelectorAll('ol.routes > li')) {
        if (row.querySelector('.route-source') !== null) continue
        if (row.querySelector('.route-signals')?.textContent?.includes('Counting signals')) w.__recounted = true
      }
    }
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  return () => page.evaluate(() => (window as unknown as { __recounted: boolean }).__recounted)
}

test('when a side street saves time, it is offered, wins and is announced', async ({ app, page }) => {
  // A jam where all three of Mapbox's routes run; Parallel Street goes past it.
  app.outside.sideStreet = true
  app.outside.traffic = JAM_WHERE_ALL_THREE_SHARE
  await app.open()
  await expect(page.locator('.route-source', { hasText: SIDE })).toBeVisible({ timeout: 15_000 })
  await app.routesReady()
  await app.snap('the side street, found by a probe, is the fastest and recommended')

  // Mapbox's own answer did not have it.
  expect(app.answers[0]!.routes.map((r) => r.name).sort()).toEqual(['A', 'B', 'C'])
  // Two probes (the budget): one found S; the other had no road within its 250 m radius (NoSegment).
  expect(app.probes.map((p) => p.road ?? 'NoSegment').sort()).toEqual(['NoSegment', 'S'])
  expect(app.probes.map((p) => p.radiuses)).toEqual([RADIUSES, RADIUSES])

  const routes = page.locator('ol.routes > li')
  await expect(routes).toHaveCount(4)
  await expect(page.locator('.route-source')).toHaveCount(1)
  await expect(routes.first()).toContainText('Recommended')
  await expect(routes.first()).toContainText(SIDE)
  await expect(routes.first()).toContainText('Fastest right now')
  // Untouched, the selection moves to the new recommended route, and says so politely.
  await expect(routes.first().getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('status').filter({ hasText: 'Faster route found' })).toHaveText(NOTICE)
  await expect(page.getByRole('status').filter({ hasText: 'Faster route found' })).toHaveAttribute('aria-live', 'polite')
  // The label reads as words: "Route 1 Recommended via side streets", not "Recommendedvia".
  await expect(page.getByRole('button', { name: /^Route 1 Recommended via side streets\b/ })).toBeVisible()
  const minutes = (await page.locator('.route-eta').allTextContents()).map((t) => Number.parseInt(t, 10))
  expect(minutes).toEqual([...minutes].sort((a, b) => a - b))

  // Nothing more goes out later: two probes for this plan, and only two.
  await page.waitForTimeout(LATE_MS)
  expect(app.probes).toHaveLength(2)
})

test('when Mapbox reports a jam, the side-street probes aim beside the jam', async ({ app, page }) => {
  // The jam is on the first stretch of Main Corridor's jog (a quarter to 40 % of the trip),
  // and Mapbox's congestion data says so. Without it the probes would go beside the middle
  // of the longest surface stretch (about half way), well past the jam.
  app.outside.sideStreet = true
  app.outside.traffic = JAM_WHERE_ALL_THREE_SHARE
  await app.open()
  await expect(page.locator('.route-source', { hasText: SIDE })).toBeVisible({ timeout: 15_000 })
  await app.routesReady()
  await app.snap('the probes went beside the reported jam and found the side street there')

  // The plan asked for congestion, and both probes sat beside the jam, one each side.
  expect(app.probes).toHaveLength(2)
  for (const probe of app.probes) {
    expect(probe.annotations).toBe('congestion,duration')
    expect(probe.via.f).toBeGreaterThan(0.25)
    expect(probe.via.f).toBeLessThan(0.4)
  }
  expect(app.probes.map((p) => Math.sign(p.via.side - 300)).sort()).toEqual([-1, 1])
  // The one on the side street's side found it.
  expect(app.probes.find((p) => p.via.side < 300)!.road).toBe('S')
})

test('with no jam reported, the probes go beside the middle of the longest stretch', async ({ app, page }) => {
  // Free flow: every segment is "low", so there is no jam to aim at and the old rule holds.
  app.outside.sideStreet = true
  await app.open()
  await expect(page.locator('.route-source', { hasText: SIDE })).toBeVisible({ timeout: 15_000 })
  await app.routesReady()
  expect(app.probes).toHaveLength(2)
  for (const probe of app.probes) {
    expect(probe.via.f).toBeGreaterThan(0.45)
    expect(probe.via.f).toBeLessThan(0.55)
  }
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
  await expect(page.getByRole('button', { name: /^Route 4 via side streets\b/ })).toBeVisible()
  await expect(page.getByText('Faster route found')).toHaveCount(0)
})

test('a probe that finds no new road adds nothing, and no third probe goes out later', async ({ app, page }) => {
  // No side street in this world: every via is more than 250 m from any road, so NoSegment.
  await app.open()
  await app.routesReady()
  await expect.poll(() => app.probes.length).toBe(2)
  await app.routesReady()
  expect(app.probes.every((p) => p.road !== 'S')).toBe(true)
  await expect(page.locator('ol.routes > li')).toHaveCount(3)
  await expect(page.locator('.route-source')).toHaveCount(0)
  await page.waitForTimeout(LATE_MS)
  expect(app.probes).toHaveLength(2)
})

test('moving a pin before the side streets are checked costs no probes for the old trip', async ({ app, page }) => {
  app.outside.sideStreet = true
  // The clock stands still, so the probes' 800 ms wait runs only when the scenario says.
  await page.clock.install()
  await page.clock.pauseAt(Date.now() + 1000)
  await app.open()
  await app.routesReady()
  expect(app.probes).toHaveLength(0)
  await page.clock.runFor(500)
  expect(app.probes).toHaveLength(0)

  // Within the 800 ms: the trip turns round.
  await page.getByRole('button', { name: 'Swap' }).click()
  await expect.poll(() => app.destinations().length).toBe(2)
  await app.routesReady()
  await page.clock.runFor(1000)
  await expect.poll(() => app.probes.length).toBe(2)
  await page.clock.runFor(3000)
  await page.waitForTimeout(500)
  await app.snap('only the new trip was probed')

  // Every probe was for the new trip (to Uptown), none for the old one (to Indian Land).
  expect(app.probes).toHaveLength(2)
  for (const probe of app.probes) expect(probe.destination).toEqual(UPTOWN)
  expect(app.probes.some((p) => p.destination.join() === INDIAN_LAND.join())).toBe(false)
  // Not even tried: the old trip's wait was cancelled, so no probe was started and then aborted either.
  expect(await app.probeAttempts()).toEqual([UPTOWN, UPTOWN])
})

test('a side street found for the old trip never shows up on the new one', async ({ app, page }) => {
  app.outside.sideStreet = true
  app.outside.traffic = JAM_WHERE_ALL_THREE_SHARE
  app.outside.holdProbes = true
  await app.open()
  await app.routesReady()
  // Both probes are out and one of them has found Parallel Street, but neither is answered yet.
  await expect.poll(() => app.probes.length).toBe(2)
  expect(app.probes.map((p) => p.road)).toContain('S')

  // The new trip's world has no side street, and its probes are answered at once.
  app.outside.sideStreet = false
  app.outside.holdProbes = false
  await page.getByRole('button', { name: 'Swap' }).click()
  await expect.poll(() => app.destinations().length).toBe(2)
  await app.routesReady()
  // The page cancelled the old trip's probes when the pin moved.
  await expect.poll(() => [...app.abortedProbes].sort()).toEqual([0, 1])

  // The old answers arrive anyway (late, from the server's side): nothing of them is shown.
  await app.releaseProbes()
  await page.waitForTimeout(LATE_MS)
  await app.snap('the new trip, with no side street from the old one')
  await expect(page.locator('ol.routes > li')).toHaveCount(3)
  await expect(page.locator('.route-source')).toHaveCount(0)
  await expect(page.getByText('Faster route found')).toHaveCount(0)
})

test('when my pointer is on the route list as a faster side street turns up, my route stays selected', async ({ app, page }) => {
  app.outside.sideStreet = true
  app.outside.traffic = JAM_WHERE_ALL_THREE_SHARE
  app.outside.holdProbes = true
  await app.open()
  await app.routesReady()
  await expect.poll(() => app.probes.length).toBe(2)
  const main = page.getByRole('button', { name: /^Route 1 Recommended/ })
  await expect(main).toHaveAttribute('aria-pressed', 'true')
  const mainDistance = await main.locator('.route-distance').textContent()
  // About to tap: the pointer is over the list.
  await page.locator('ol.routes').hover()

  await app.releaseProbes()
  await expect(page.locator('.route-source', { hasText: SIDE })).toBeVisible()
  await app.routesReady()
  await app.snap('the side street is recommended, but the route under my pointer stays selected')

  const routes = page.locator('ol.routes > li')
  await expect(routes.first()).toContainText(SIDE)
  // The side street is recommended and announced, but not selected: the route I was about to tap still is.
  await expect(routes.first().getByRole('button')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('status').filter({ hasText: 'Faster route found' })).toHaveText(NOTICE)
  const selected = page.locator('ol.routes button[aria-pressed="true"]')
  await expect(selected).toHaveCount(1)
  await expect(selected).not.toContainText(SIDE)
  await expect(selected.locator('.route-distance')).toHaveText(mainDistance!)
})

test('when Start drive has focus as a faster side street turns up, the route on screen stays selected', async ({ app, page }) => {
  app.outside.sideStreet = true
  app.outside.traffic = JAM_WHERE_ALL_THREE_SHARE
  app.outside.holdProbes = true
  await app.open()
  await app.routesReady()
  await expect.poll(() => app.probes.length).toBe(2)
  await page.getByRole('button', { name: 'Start drive' }).focus()

  await app.releaseProbes()
  await expect(page.locator('.route-source', { hasText: SIDE })).toBeVisible()
  const routes = page.locator('ol.routes > li')
  await expect(routes.first()).toContainText(SIDE)
  await expect(routes.first().getByRole('button')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('ol.routes button[aria-pressed="true"]')).toHaveCount(1)
  await expect(page.locator('ol.routes button[aria-pressed="true"]')).not.toContainText(SIDE)
})

test('when a side street joins, the other routes keep their signal counts', async ({ app, page }) => {
  app.outside.sideStreet = true
  app.outside.traffic = JAM_WHERE_ALL_THREE_SHARE
  app.outside.holdProbes = true
  await app.open()
  await app.routesReady()
  await expect.poll(() => app.probes.length).toBe(2)
  const before = await page.locator('.route-signals').allTextContents()
  for (const signals of before) expect(signals).toMatch(/^\d+ signals?$/)
  const recounted = await watchForRecount(page)

  await app.releaseProbes()
  await expect(page.locator('.route-source', { hasText: SIDE })).toBeVisible()
  await app.routesReady()
  // Mapbox's three routes never went back to "Counting signals…" while the side street's count came in.
  expect(await recounted()).toBe(false)
  const after = await page.locator('ol.routes > li').filter({ hasNot: page.locator('.route-source') }).locator('.route-signals').allTextContents()
  expect(after.sort()).toEqual([...before].sort())
})

test('when I start on the side-street route, it drives the side street', async ({ app, page }) => {
  app.outside.sideStreet = true
  app.outside.traffic = JAM_WHERE_ALL_THREE_SHARE
  await app.open({ fakeClock: true })
  await expect(page.locator('.route-source', { hasText: SIDE })).toBeVisible({ timeout: 15_000 })
  await app.routesReady()
  const routes = page.locator('ol.routes > li')
  await expect(routes.first()).toContainText(SIDE)
  await expect(routes.first().getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  await app.snap('Parallel Street is selected; Start drive next')
  const probesBefore = app.probes.length
  expect(probesBefore).toBe(2)
  const plannedRequests = app.directionsRequests

  // The driver takes Parallel Street, the route on screen, all the way.
  const log = await app.drive({ road: 'S', snapAtSec: [30, 600] })
  await app.snap('arrived on Parallel Street: the summary')

  expect(log.arrived).toBe(true)
  expect(log.banners).toEqual([])
  const spoken = await app.spoken()
  expect(spoken[0]).toBe('RouteIQ started')
  // The app was on Parallel Street with the driver: never off the route, never switched,
  // and none of Main Corridor's jog via Cross Street was spoken.
  expect(spoken).not.toContain(OFF_ROUTE)
  expect(spoken.filter((line) => line.startsWith('Switching'))).toEqual([])
  expect(spoken.some((line) => line.includes('Cross Street'))).toBe(false)
  expect(spoken.at(-1)).toMatch(/^You have arrived\. Trip time \d+ minutes\.$/)
  // Start asked Mapbox for nothing: the drive's first request is its first check, and the
  // path check right after it is the second (with a request of its own at Start it would be the third).
  expect(app.pathChecks[0]?.n).toBe(plannedRequests + 2)
  // Mapbox never offered the side street by itself, so each check that needed it asked
  // for the path itself, through vias along it, and got Parallel Street back: like for like.
  expect(app.answers.filter((a) => a.n > plannedRequests && a.routes.length > 1).every((a) => a.routes.every((r) => r.name !== 'S'))).toBe(true)
  expect(app.pathChecks.length).toBeGreaterThan(0)
  expect(app.pathChecks.every((c) => c.road === 'S')).toBe(true)
  // Probes are a plan-screen thing for now (#5): the drive made none.
  expect(app.probes).toHaveLength(probesBefore)
  await expect(page.getByLabel('Drive summary')).toBeVisible()
})

test('when I pick a slower route on purpose, it drives that route', async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  // Mapbox's second-fastest route: not the recommended one.
  const second = app.answers[0]!.routes[1]!.name as 'B' | 'C'
  const turnOnto = second === 'B' ? 'East Loop' : 'West Loop'
  const row = page.locator('ol.routes > li').nth(1)
  await expect(row).not.toContainText('Recommended')
  await row.getByRole('button').click()
  await expect(row.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  await app.snap(`the slower ${turnOnto} picked on purpose`)

  const log = await app.drive({ road: second })
  await app.snap(`arrived by ${turnOnto}`)

  expect(log.arrived).toBe(true)
  expect(log.banners).toEqual([])
  const spoken = await app.spoken()
  expect(spoken).not.toContain(OFF_ROUTE)
  expect(spoken.filter((line) => line.startsWith('Switching'))).toEqual([])
  // The turns spoken are the picked route's own.
  expect(spoken.some((line) => line.includes(turnOnto))).toBe(true)
  expect(spoken.at(-1)).toMatch(/^You have arrived\. Trip time \d+ minutes\.$/)
})
