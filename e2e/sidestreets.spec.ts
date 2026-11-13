import type { Page } from '@playwright/test'
import { expect, INDIAN_LAND, test, UPTOWN } from './harness.ts'
import { FREE_FLOW, type Traffic } from './world/roads.ts'
import { everyRoadSlow, freewayJam, JAM_WHERE_ALL_THREE_SHARE, jamWhereAllThreeShare } from './world/traffic.ts'

// Side-street probing on the plan screen (PLAN step 11b). Mapbox offers three
// routes at most; the made-up network here also has Parallel Street (S), which
// Mapbox never offers. After the three routes are on screen the app asks for
// the trip again through a point beside the fastest one, finds S, and ranks it
// like any other route: on ETA.
//
// And during a drive (PLAN step 11c, #5): each check for a faster route may also
// ask through one point beside the road ahead, so a side street the plan did not
// recommend can still be found when a jam builds, and the reroute engine judges
// it by its usual rules (2 minutes and 5 % saved, two checks in a row, lead).

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
  // No turn ahead where the side street carries straight on: the card still leads with a distance (#45).
  const turnCard = page.getByLabel('Next turn')
  const log = await app.drive({
    road: 'S',
    snapAtSec: [30, 600],
    lookAtSec: [
      {
        atSec: 30,
        look: async () => {
          await expect(turnCard.locator('.live-turn-distance')).toHaveText(/^\d+(\.\d)? mi$/)
          await expect(turnCard.locator('.live-turn-road')).toHaveText('Continue on Parallel Street')
          await expect(turnCard.locator('[data-arrow="straight"]')).toBeVisible()
        },
      },
    ],
  })
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
  // Parallel Street is not held up (the jam is on Main Corridor), so the drive's checks made no
  // side-street probes (#5): a probe is only worth a request on a route that is losing time.
  expect(app.probes.slice(probesBefore)).toEqual([])
  await expect(page.getByLabel('Drive summary')).toBeVisible()
})

/** The drive's probes that came back on Parallel Street, with what Main Corridor took at the same check. */
function sideStreetFinds(app: { probes: { forRequest: number; duringDrive: boolean; road: string | null; durationSec: number | null }[]; answers: { n: number; routes: { name: string; durationSec: number }[] }[] }) {
  return app.probes
    .filter((p) => p.duringDrive && p.road === 'S')
    .map((p) => ({ n: p.forRequest, sideSec: p.durationSec!, mainSec: app.answers.find((a) => a.n === p.forRequest)?.routes.find((r) => r.name === 'A')?.durationSec ?? null }))
}

test('when a jam builds during the drive, a side street found mid-drive takes me round it', async ({ app, page }) => {
  // Planned in free flow: Main Corridor is recommended and Parallel Street is shown last.
  // From the drive's first check, Main Corridor jams (3x) where Mapbox's three routes all run.
  app.outside.sideStreet = true
  app.outside.traffic = jamWhereAllThreeShare(3)
  await app.open({ fakeClock: true })
  await expect(page.locator('.route-source', { hasText: SIDE })).toBeVisible({ timeout: 15_000 })
  await app.routesReady()
  const routes = page.locator('ol.routes > li')
  await expect(routes.first()).not.toContainText(SIDE)
  await expect(routes.first().getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  await app.snap('planned in free flow: Main Corridor recommended, Parallel Street last')
  const probesBefore = app.probes.length

  const log = await app.drive({ road: 'A', snapAtSec: [600] })
  await app.snap('arrived by Parallel Street: the summary lists the switch')

  expect(log.arrived).toBe(true)
  // Mapbox never offered Parallel Street during the drive; only the drive's own probes found it.
  const offered = app.answers.filter((a) => !app.pathChecks.some((c) => c.n === a.n))
  expect(offered.every((a) => a.routes.every((r) => r.name !== 'S'))).toBe(true)
  const finds = sideStreetFinds(app)
  expect(finds.length).toBeGreaterThanOrEqual(2)
  // One probe per check at most, from the car with its heading.
  const perCheck = new Map<number, number>()
  for (const p of app.probes.slice(probesBefore)) perCheck.set(p.forRequest, (perCheck.get(p.forRequest) ?? 0) + 1)
  expect(Math.max(...perCheck.values())).toBe(1)
  expect(app.probes.slice(probesBefore).every((p) => p.duringDrive && p.radiuses === RADIUSES)).toBe(true)

  // One switch, onto the side street, after it held up for two checks in a row, with a way to undo it.
  expect(log.banners).toHaveLength(1)
  expect(log.banners[0]!.text).toContain('Switching to a faster route via side streets')
  expect(log.banners[0]!.text).toContain('Keep my route')
  const spoken = await app.spoken()
  const switches = spoken.filter((line) => line.startsWith('Switching'))
  expect(switches).toHaveLength(1)
  expect(switches[0]).toMatch(/^Switching to a faster route via side streets\. Saves \d+ minutes\. Turn in [\d.]+ miles\.$/)
  const saved = Number(/Saves (\d+) minutes/.exec(switches[0]!)![1])
  expect(saved).toBeGreaterThanOrEqual(2)
  // It waited for the confirmation: the check before the switch said so.
  expect(log.statusLines.some((l) => /^Staying: faster route saves [\d.]+ minutes, confirming, check 1 of 2$/.test(l.text))).toBe(true)
  // The driver then stays on Parallel Street to the end: no Cross Street jog of Main Corridor after the switch.
  const after = spoken.slice(spoken.indexOf(switches[0]!) + 1)
  expect(after.some((line) => line.includes('Cross Street'))).toBe(false)
  expect(spoken).not.toContain(OFF_ROUTE)
  expect(spoken.at(-1)).toMatch(/RouteIQ changed route once\.$/)
  await expect(page.getByLabel('Drive summary')).toBeVisible()
})

test('when a side street found mid-drive saves only about a minute, it stays on my route', async ({ app, page }) => {
  // The same jam, but 2x: Parallel Street is faster now, by about a minute, under the 2 minutes a switch needs.
  app.outside.sideStreet = true
  app.outside.traffic = jamWhereAllThreeShare(2)
  await app.open({ fakeClock: true })
  await app.routesReady()
  await expect(page.locator('ol.routes > li').first()).not.toContainText(SIDE)

  const log = await app.drive({ road: 'A', snapAtSec: [200] })
  await app.snap('arrived on Main Corridor: no switch')

  expect(log.arrived).toBe(true)
  // The probes did find the side street, and it was faster, by under 2 minutes.
  const finds = sideStreetFinds(app).filter((f) => f.mainSec !== null && f.sideSec < f.mainSec)
  expect(finds.length).toBeGreaterThanOrEqual(1)
  for (const f of finds) expect(f.mainSec! - f.sideSec).toBeLessThan(120)
  // The engine said why it stayed, and it never switched.
  expect(log.statusLines.some((l) => /^Staying: faster route saves only [\d.]+ (minute|minutes|seconds)$/.test(l.text))).toBe(true)
  expect(log.banners).toEqual([])
  const spoken = await app.spoken()
  expect(spoken.filter((line) => line.startsWith('Switching'))).toEqual([])
  expect(spoken).not.toContain(OFF_ROUTE)
  // Main Corridor's own turns, the Cross Street jog included, all the way.
  expect(spoken).toContain('Turn right onto Cross Street.')
  expect(spoken.at(-1)).toMatch(/^You have arrived\. Trip time \d+ minutes\.$/)
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

test('when the side streets keep losing, it stops asking after three losses', async ({ app }) => {
  // Every road 1.6 times slower from the drive's first check to the end: every check is on a route
  // well over its typical time and may probe, and every probe finds Parallel Street slower than
  // staying (the desk drive of #183: 18 probes, all 4 to 6 minutes slower). The traffic ahead
  // stays 1.6 times its usual time all the way, so nothing re-arms the probes.
  const slow: Traffic = (route, at, n) => FREE_FLOW(route, at, n) * (n >= 2 ? 1.6 : 1)
  app.outside.sideStreet = true
  app.outside.traffic = slow
  await app.open({ fakeClock: true })
  await app.routesReady()
  const probesBefore = app.probes.length
  const before = app.directionsRequests

  const log = await app.drive({ road: 'A', snapAtSec: [600] })
  await app.snap('arrived on Main Corridor after three losing probes')

  expect(log.arrived).toBe(true)
  const driveProbes = app.probes.slice(probesBefore).filter((p) => p.duringDrive)
  const checks = app.answers.filter((a) => a.n > before && !app.pathChecks.some((c) => c.n === a.n)).map((a) => a.n)
  // A loss is Parallel Street found and slower than staying; a probe that found no road there tells nothing.
  const losses = driveProbes.filter((p) => p.road === 'S')
  expect(losses).toHaveLength(3)
  for (const l of losses) expect(l.durationSec).toBeGreaterThan(app.answers.find((a) => a.n === l.forRequest)!.routes.find((r) => r.name === 'A')!.durationSec)
  // After the third loss no probe goes out for the rest of the drive, while the checks go on.
  const thirdAt = losses[2]!.forRequest
  expect(driveProbes.filter((p) => p.forRequest > thirdAt)).toEqual([])
  expect(checks.filter((n) => n > thirdAt).length).toBeGreaterThanOrEqual(5)
  expect(log.banners).toEqual([])
  const spoken = await app.spoken()
  expect(spoken.filter((line) => line.startsWith('Switching'))).toEqual([])
  expect(spoken.at(-1)).toMatch(/^You have arrived\. Trip time \d+ minutes\.$/)
})

test('when the side streets keep losing, they never use up the checks before I arrive', async ({ app, page }) => {
  // Every road is slow from the drive's first check to the end, so every check is on a route
  // well over its typical time and may probe, and every probe finds Parallel Street slower than
  // staying (the desk drive of #183: 18 probes, all 4 to 6 minutes slower). A tight budget of 30
  // requests: a check with a probe and its path check costs 3, so probes alone would spend it in
  // about ten checks, and the last part of the drive would have no checks at all.
  app.outside.sideStreet = true
  app.outside.traffic = everyRoadSlow()
  await app.open({ fakeClock: true })
  await app.routesReady()
  await page.locator('details.drive-settings > summary').click()
  await page.getByLabel('Directions requests per drive (at most)').fill('30')
  const before = app.directionsRequests
  const probesBefore = app.probes.length
  // The drive's requests so far: its checks and path checks, and its probes.
  const requests = () => app.directionsRequests - before + app.probes.length - probesBefore

  // How many requests the drive had made, minute by minute.
  const used: { atSec: number; requests: number }[] = []
  const lookAtSec = Array.from({ length: 40 }, (_, i) => ({ atSec: 60 * (i + 1), look: async () => void used.push({ atSec: 60 * (i + 1), requests: requests() }) }))
  const log = await app.drive({ road: 'A', lookAtSec, snapAtSec: [300, 900] })
  await app.snap('arrived on Main Corridor: checked all the way, never out of requests')

  expect(log.arrived).toBe(true)
  // Probes did go out, and every one lost: no switch.
  const driveProbes = app.probes.slice(probesBefore).filter((p) => p.duringDrive)
  expect(driveProbes.length).toBeGreaterThanOrEqual(1)
  expect(log.banners).toEqual([])
  // The budget was never used up, and the checks went on into the last two minutes of the drive.
  expect(log.statusLines.filter((l) => l.text.startsWith('Request budget used up'))).toEqual([])
  const total = requests()
  expect(total).toBeLessThanOrEqual(30)
  const twoMinutesBefore = used.filter((u) => u.atSec <= log.seconds - 120).at(-1)!
  expect(total).toBeGreaterThan(twoMinutesBefore.requests)
  const spoken = await app.spoken()
  expect(spoken.filter((line) => line.startsWith('Switching'))).toEqual([])
  expect(spoken.at(-1)).toMatch(/^You have arrived\. Trip time \d+ minutes\.$/)
})

// Probes beside a freeway jam (#183, items 3 and 6), behind the "Probe beside freeway jams"
// setting (core ProbeOptions.freewayJams), off by default until a phone drive. In the world with
// a freeway, Main Corridor's middle is a freeway and Service Road (F) runs 800 m beside it;
// Mapbox never offers Service Road. freewayJam: the freeway jams (4x) from 27 % to 40 % of the
// trip, where Mapbox's three routes all run, from the drive's first check on.

/** In the jam's stretch of the trip, and off the freeway's line: a via aimed beside the freeway jam. */
const besideTheJam = (via: { f: number; side: number }) => via.f > 0.27 && via.f < 0.4 && Math.abs(via.side - 300) >= 500

async function freewayJamsSetting(page: Page, on: boolean) {
  await page.locator('details.drive-settings > summary').click()
  const box = page.getByLabel('Probe beside freeway jams (off until a phone drive)')
  await expect(box).not.toBeChecked()
  if (on) await box.check()
  await page.locator('details.drive-settings > summary').click()
}

test('when the freeway jams, it takes me off onto the road beside it and back on after', async ({ app, page }) => {
  app.outside.freeway = true
  app.outside.traffic = freewayJam()
  await app.open({ fakeClock: true })
  await app.routesReady()
  await freewayJamsSetting(page, true)
  await app.snap('planned in free flow on the freeway, freeway-jam probes switched on')
  const probesBefore = app.probes.length

  const log = await app.drive({ road: 'A', snapAtSec: [600] })
  await app.snap('arrived by Service Road: the summary lists the switch')

  expect(log.arrived).toBe(true)
  // Mapbox never offered Service Road; only the drive's probes beside the freeway jam found it.
  const offered = app.answers.filter((a) => !app.pathChecks.some((c) => c.n === a.n))
  expect(offered.every((a) => a.routes.every((r) => r.name !== 'F'))).toBe(true)
  const driveProbes = app.probes.slice(probesBefore).filter((p) => p.duringDrive)
  const finds = driveProbes.filter((p) => p.road === 'F')
  expect(finds.length).toBeGreaterThanOrEqual(2)
  // Each find came from a via beside the jam on the freeway, and beat staying on the freeway by over 3 minutes.
  for (const p of finds) {
    expect(besideTheJam(p.via)).toBe(true)
    const mainSec = app.answers.find((a) => a.n === p.forRequest)!.routes.find((r) => r.name === 'A')!.durationSec
    expect(mainSec - p.durationSec!).toBeGreaterThan(180)
  }
  // One probe per check at most.
  const perCheck = new Map<number, number>()
  for (const p of driveProbes) perCheck.set(p.forRequest, (perCheck.get(p.forRequest) ?? 0) + 1)
  expect(Math.max(...perCheck.values())).toBe(1)

  // One switch, onto the road beside the freeway, after two checks in a row.
  expect(log.statusLines.some((l) => /^Staying: faster route saves [\d.]+ minutes, confirming, check 1 of 2$/.test(l.text))).toBe(true)
  expect(log.banners).toHaveLength(1)
  expect(log.banners[0]!.text).toContain('Switching to a faster route via side streets')
  const spoken = await app.spoken()
  const switches = spoken.filter((line) => line.startsWith('Switching'))
  expect(switches).toHaveLength(1)
  expect(switches[0]).toMatch(/^Switching to a faster route via side streets\. Saves [\d.]+ minutes\. Turn in [\d.]+ miles\.$/)
  expect(Number(/Saves ([\d.]+) minutes/.exec(switches[0]!)![1])).toBeGreaterThanOrEqual(3)
  // Off the freeway onto Service Road, and back onto Main Corridor after the jam.
  const after = spoken.slice(spoken.indexOf(switches[0]!) + 1)
  const ontoService = after.findIndex((line) => /^Turn (left|right) onto Service Road\.$/.test(line))
  expect(ontoService).toBeGreaterThanOrEqual(0)
  expect(after.slice(ontoService + 1).some((line) => /^Turn (left|right) onto Main Corridor\.$/.test(line))).toBe(true)
  expect(spoken).not.toContain(OFF_ROUTE)
  expect(spoken.at(-1)).toMatch(/RouteIQ changed route once\.$/)
})

test('with the freeway-jam probes off, a freeway jam sends no probe beside the freeway', async ({ app, page }) => {
  // The same jam, the setting left at its default (off): the drive is as before #183's items 3 and 6.
  app.outside.freeway = true
  app.outside.traffic = freewayJam()
  await app.open({ fakeClock: true })
  await app.routesReady()
  await freewayJamsSetting(page, false)
  const probesBefore = app.probes.length

  const log = await app.drive({ road: 'A', snapAtSec: [300] })
  await app.snap('arrived on Main Corridor: no probe beside the freeway')

  expect(log.arrived).toBe(true)
  const driveProbes = app.probes.slice(probesBefore).filter((p) => p.duringDrive)
  // The delay over the typical time still opened the gate, so probes went out, as on the desk
  // drive of #183: at the surface stretches, where no road is, never beside the freeway jam.
  expect(driveProbes.length).toBeGreaterThanOrEqual(1)
  expect(driveProbes.filter((p) => besideTheJam(p.via))).toEqual([])
  expect(driveProbes.filter((p) => p.road === 'F')).toEqual([])
  expect(log.banners).toEqual([])
  const spoken = await app.spoken()
  expect(spoken.filter((line) => line.startsWith('Switching'))).toEqual([])
  expect(spoken.some((line) => line.includes('Service Road'))).toBe(false)
  expect(spoken.at(-1)).toMatch(/^You have arrived\. Trip time \d+ minutes\.$/)
})

test('after it stops asking, a jam that gets worse makes it try the side streets again', async ({ app }) => {
  // As above, every road 1.6 times slower, until the drive's later checks (request 15 on), when
  // every road gets 2.2 times slower: the slowdown ahead moves by 0.6, far past the 0.1 that
  // ends the back-off, so the side streets are worth another look.
  const CHANGE_AT = 15
  const worse: Traffic = (route, at, n) => FREE_FLOW(route, at, n) * (n >= CHANGE_AT ? 2.2 : n >= 2 ? 1.6 : 1)
  app.outside.sideStreet = true
  app.outside.traffic = worse
  await app.open({ fakeClock: true })
  await app.routesReady()
  const probesBefore = app.probes.length

  const log = await app.drive({ road: 'A' })
  await app.snap('arrived: the probes stopped, then came back once the jam got worse')

  expect(log.arrived).toBe(true)
  const driveProbes = app.probes.slice(probesBefore).filter((p) => p.duringDrive)
  const losses = driveProbes.filter((p) => p.road === 'S')
  expect(losses.length).toBeGreaterThanOrEqual(3)
  const thirdAt = losses[2]!.forRequest
  expect(thirdAt).toBeLessThan(CHANGE_AT)
  // Nothing between the third loss and the change; a probe again after it.
  expect(driveProbes.filter((p) => p.forRequest > thirdAt && p.forRequest < CHANGE_AT)).toEqual([])
  expect(driveProbes.filter((p) => p.forRequest >= CHANGE_AT).length).toBeGreaterThanOrEqual(1)
  expect(log.banners).toEqual([])
})

test('on a 40-minute drive that is slow from the start, the side streets are tried early and the checks still last to the end', async ({ app }) => {
  // Every road 2.2 times its usual pace, the plan included: the trip reads about 43 minutes,
  // held up from the start, with the usual budget of 60 requests. Keeping back one request per
  // minute left (plus 3) leaves room for a probe at once; keeping back 1.5 per minute did not
  // (a rush-hour desk drive on #186 sent 1 probe in 40 minutes).
  app.outside.sideStreet = true
  app.outside.traffic = everyRoadSlow(2.2, 1)
  await app.open({ fakeClock: true })
  await app.routesReady()
  const before = app.directionsRequests
  const probesBefore = app.probes.length

  // The car keeps the pace the travel time says (about 10 m/s), so the time left falls a minute a minute.
  const log = await app.drive({ road: 'A', speedMps: 10, maxSec: 3200, snapAtSec: [120] })
  await app.snap('arrived: probed early, checked to the end')

  expect(log.arrived).toBe(true)
  const checks = app.answers.filter((a) => a.n > before && !app.pathChecks.some((c) => c.n === a.n)).map((a) => a.n)
  const driveProbes = app.probes.slice(probesBefore).filter((p) => p.duringDrive)
  // A probe on one of the first three checks.
  expect(driveProbes.some((p) => checks.slice(0, 3).includes(p.forRequest))).toBe(true)
  // And the budget lasted: never used up, all 60 or fewer.
  expect(log.statusLines.filter((l) => l.text.startsWith('Request budget used up'))).toEqual([])
  expect(app.directionsRequests - before + driveProbes.length).toBeLessThanOrEqual(60)
  expect(log.banners).toEqual([])
})
