import { expect, test } from './harness.ts'
import { JAM_ON_A_FROM_SECOND_CHECK, NOISY_BUT_NOTHING_FASTER } from './world/traffic.ts'

// Live drives on the fake clock and fake GPS, through the real live-drive
// code: the app asks for routes, decides, speaks, and the made-up driver does
// what it says. The trip is the app's test trip, Uptown Charlotte to
// US-521 & SC-160; the roads in between are made up (e2e/world/roads.ts).
// Directions request 1 is the plan screen; the drive sets off on the route
// picked there with no request of its own (#66), and 2 and on are the checks
// for a faster route, about once a minute.

const STARTED = 'RouteIQ started'
const OFF_ROUTE = 'You are off the route. Finding a new one.'

test('I start a drive and it speaks the turns in order, then says I have arrived', async ({ app }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  await app.snap('the trip, before Start drive')
  const log = await app.drive({ snapAtSec: [60, 290] })
  await app.snap('arrived: the summary')

  expect(log.arrived).toBe(true)
  expect(log.banners).toEqual([])
  expect(await app.spoken()).toEqual([
    STARTED,
    'In half a mile, turn left onto Cross Street.',
    'Turn left onto Cross Street.',
    'Turn right onto Main Corridor.',
    'In half a mile, turn right onto Cross Street.',
    'Turn right onto Cross Street.',
    'Turn left onto Main Corridor.',
    'Your destination is ahead.',
    'You have arrived. Trip time 17 minutes.',
  ])
})

test('when a faster route holds up, it switches by itself and tells me once', async ({ app, page }) => {
  // From the second check on, the middle of the direct route jams; the East Loop goes round it.
  app.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
  await app.open({ fakeClock: true })
  await app.routesReady()
  const log = await app.drive()
  await app.snap('arrived: the summary lists the switch')

  expect(log.arrived).toBe(true)
  // One switch, after the jam held up for two checks in a row (requests 3 and 4), shown with a way to undo it.
  expect(log.banners).toHaveLength(1)
  expect(log.banners[0]!.text).toContain('Switched to a faster route')
  expect(log.banners[0]!.text).toContain('Keep previous route')
  const spoken = await app.spoken()
  const switches = spoken.filter((line) => line.startsWith('Switching'))
  expect(switches).toHaveLength(1)
  expect(switches[0]).toMatch(/^Switching to a faster route\. Saves \d+ minutes\. Turn in [\d.]+ miles\.$/)
  // The driver then takes the East Loop, and the turns are spoken for it.
  expect(spoken).toContain('Turn left onto East Loop.')
  expect(spoken).not.toContain(OFF_ROUTE)
  expect(spoken.at(-1)).toMatch(/RouteIQ changed route once\.$/)
  await expect(page.getByLabel('Drive summary')).toBeVisible()
})

test('when a route check never answers, it gives up on it and the next checks still find the faster route', async ({ app }) => {
  // The drive's first check (request 2, a minute in) hangs, as a request can in a dead zone.
  // From the second check on, the direct route jams; the East Loop goes round it.
  app.outside.hangRequests = [2]
  app.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
  await app.open({ fakeClock: true })
  await app.routesReady()
  const log = await app.drive({ snapAtSec: [70, 92] })
  await app.snap('arrived: the summary lists the switch')

  // The page itself cancelled the hung check (after requestTimeoutSec), and kept checking.
  expect(app.cancelledHanging).toEqual([2])
  expect(app.directionsRequests).toBeGreaterThanOrEqual(4)
  expect(log.arrived).toBe(true)
  expect(log.banners).toHaveLength(1)
  expect(log.banners[0]!.text).toContain('Switched to a faster route')
  const spoken = await app.spoken()
  expect(spoken.filter((line) => line.startsWith('Switching'))).toHaveLength(1)
  expect(spoken).toContain('Turn left onto East Loop.')
  expect(spoken).not.toContain(OFF_ROUTE)
})

test('when the phone clock is put back half a minute mid-drive, the car keeps moving and every turn is spoken', async ({ app }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  // Three minutes in, just before the first turn prompt, the wall clock goes back 30 s (#30).
  const log = await app.drive({ clockBackAtSec: 180, snapAtSec: [200], readTurnAtSec: [178, 188, 198, 208] })
  await app.snap('arrived: the summary')

  // The next turn keeps coming nearer through the half minute the clock went back: the car never stood still.
  const meters = log.turnDistances.map((d) => d.meters)
  expect(meters).toHaveLength(4)
  expect(meters.every((m) => m !== null)).toBe(true)
  for (let i = 1; i < meters.length; i++) expect(meters[i]!).toBeLessThan(meters[i - 1]!)
  expect(log.arrived).toBe(true)
  expect(log.banners).toEqual([])
  expect(await app.spoken()).toEqual([
    STARTED,
    'In half a mile, turn left onto Cross Street.',
    'Turn left onto Cross Street.',
    'Turn right onto Main Corridor.',
    'In half a mile, turn right onto Cross Street.',
    'Turn right onto Cross Street.',
    'Turn left onto Main Corridor.',
    'Your destination is ahead.',
    'You have arrived. Trip time 17 minutes.',
  ])
})

test('when nothing is faster, it never switches', async ({ app }) => {
  // Traffic wobbles by up to 6 % from check to check, and the GPS wanders up to 8 m off the road.
  app.outside.traffic = NOISY_BUT_NOTHING_FASTER
  await app.open({ fakeClock: true })
  await app.routesReady()
  const log = await app.drive({ gpsNoiseM: 8, snapAtSec: [300] })
  await app.snap('arrived: no route changes')

  // The wobble did make another route look a little quicker at some checks: this is not a quiet drive.
  const tempting = app.answers.filter(({ n, routes }) => n >= 2 && routes.length > 1 && routes[0]!.name !== 'A')
  expect(tempting.length).toBeGreaterThan(0)

  expect(log.arrived).toBe(true)
  expect(log.banners).toEqual([])
  const spoken = await app.spoken()
  expect(spoken.filter((line) => line.startsWith('Switching'))).toEqual([])
  expect(spoken).not.toContain(OFF_ROUTE)
  expect(spoken.at(-1)).toBe('You have arrived. Trip time 17 minutes.')
})

test('a wrong turn: it says I am off the route, finds a new one and gets me there', async ({ app }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  // Two minutes in, the driver turns right off the Main Corridor and keeps going.
  const log = await app.drive({ wrongTurnAtSec: 120, snapAtSec: [124] })
  await app.snap('arrived')

  expect(log.arrived).toBe(true)
  expect(log.banners).toHaveLength(1)
  expect(log.banners[0]!.text).toContain('New route')
  // Noticed within half a minute of the wrong turn.
  expect(log.banners[0]!.atSec).toBeLessThan(150)
  const spoken = await app.spoken()
  expect(spoken.slice(0, 3)).toEqual([STARTED, OFF_ROUTE, expect.stringMatching(/^New route\. \d+ minutes to your destination\.$/)])
  expect(spoken.filter((line) => line === OFF_ROUTE)).toHaveLength(1)
  expect(spoken.at(-1)).toMatch(/RouteIQ changed route once\.$/)
})

test('the map fills the drive view, and fits the trip screen again after End', async ({ app, page }) => {
  await app.open()
  await app.routesReady()
  const map = page.getByTestId('map')
  const canvas = page.locator('canvas.mapboxgl-canvas')
  const widths = async () => ({ map: Math.round((await map.boundingBox())!.width), canvas: Math.round((await canvas.boundingBox())!.width) })
  const planWidth = (await widths()).map

  await page.getByRole('button', { name: 'Start drive' }).click()
  await page.evaluate(() => (window as unknown as { __e2e: { fix: (...a: number[]) => void } }).__e2e.fix(-80.8431, 35.2271, 180, 0))
  // The drive view is wider than the trip screen's map, and the drawing grows with it.
  await expect.poll(async () => (await widths()).map).toBeGreaterThan(planWidth)
  await expect.poll(widths).toEqual({ map: (await widths()).map, canvas: (await widths()).map })
  await app.snap('the drive view: the map fills the width')

  await page.getByRole('button', { name: 'End' }).click()
  await expect(page.locator('.route-badge', { hasText: 'Recommended' })).toBeVisible()
  await expect.poll(widths).toEqual({ map: planWidth, canvas: planWidth })
  await app.snap('after End: the trip screen, map beside the panel')
})
