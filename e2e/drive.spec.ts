import { expect, test } from './harness.ts'
import { BLOCK_OF_A_CLOSED_FROM_SECOND_CHECK, JAM_ON_A_FROM_SECOND_CHECK, NOISY_BUT_NOTHING_FASTER } from './world/traffic.ts'

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

test('when a block ahead is closed, it reroutes around it', async ({ app }) => {
  // From the second check on, a block of Main Corridor's own stretch (60 to 70 % of the way) is
  // closed. Traffic flows freely, so no route is faster by time: only the closure can move the drive.
  app.outside.closed = BLOCK_OF_A_CLOSED_FROM_SECOND_CHECK
  await app.open({ fakeClock: true })
  await app.routesReady()
  const log = await app.drive({ snapAtSec: [150] })
  await app.snap('arrived: the summary lists the change')

  expect(log.arrived).toBe(true)
  // Mapbox stops offering A, and the drive's check of A itself comes back "no route" each time.
  const closedChecks = app.pathChecks.filter((c) => c.road === 'NoRoute')
  expect(closedChecks.length).toBeGreaterThanOrEqual(3)
  // One change of route, made only once three checks in a row found no way along A (DEFAULT_REROUTE_OPTIONS.routeLostPolls).
  expect(log.banners).toHaveLength(1)
  const spoken = await app.spoken()
  const switches = spoken.filter((line) => line.startsWith('Switching'))
  expect(switches).toEqual([expect.stringMatching(/^Switching routes\. The road ahead on your route looks closed\. Turn in [\d.]+ miles\.$/)])
  const statusBefore = log.statusLines.filter((l) => l.atSec < log.banners[0]!.atSec).map((l) => l.text)
  expect(statusBefore).toEqual(expect.arrayContaining([expect.stringContaining('check 1 of 3'), expect.stringContaining('check 2 of 3')]))
  // The driver takes one of the loops round the closed block and is never told to turn back.
  expect(spoken.some((line) => line.includes('East Loop') || line.includes('West Loop'))).toBe(true)
  expect(spoken).not.toContain(OFF_ROUTE)
  expect(spoken.at(-1)).toMatch(/RouteIQ changed route once\.$/)
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

test('right after Start, "checked" says how old the plan is, not 0 s', async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  // The trip was planned, then the driver waited 40 s before tapping Start drive (#71).
  await page.clock.fastForward(40_000)
  // And the machine running this is slow at the wrong moment: the clock flake of #71 stays covered.
  app.slowMomentAtStartMs = 1500
  await app.drive({ maxSec: 6 })
  await app.snap('just after Start: checked about 45 s ago')

  const text = (await page.getByText(/checked \d+ s ago/).textContent()) ?? ''
  const seconds = Number(/checked (\d+) s ago/.exec(text)?.[1])
  expect(seconds).toBeGreaterThanOrEqual(45)
  expect(seconds).toBeLessThan(60)
  // The first check is still to come: it is due a minute after the plan, not after the tap.
  expect(app.directionsRequests).toBe(1)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

  test('the driving screen shows the next turn and its distance large, one line for the arrival, and the rest behind More', async ({ app, page }) => {
    await app.open({ fakeClock: true })
    await app.routesReady()
    const turnCard = page.getByLabel('Next turn')
    const sheet = page.getByLabel('Live drive')
    const mute = page.getByRole('button', { name: 'Mute' })

    const log = await app.drive({
      maxSec: 70,
      lookAtSec: [
        {
          atSec: 60,
          look: async () => {
            // The turn card: the distance to the next turn is the hero, over the street to turn onto.
            await expect(turnCard.locator('.live-turn-distance')).toHaveText('2.9 mi')
            await expect(turnCard.locator('.live-turn-road')).toHaveText('Turn left: Cross Street')
            await expect(turnCard.locator('[data-arrow="left"]')).toBeVisible()
            // One line: the time left, and the arrival time.
            await expect(sheet.locator('.live-eta')).toHaveText(/^\d+ minArrive \d{1,2}:\d{2} AM$/)
            // Two figures at a glance: the lights, the distance left and the voice are not on this screen.
            await expect(mute).toHaveCount(0)
            await expect(sheet).not.toContainText('Lights')
            await expect(page.getByRole('button', { name: 'End' })).toBeVisible()
            // The turn card and the sheet leave the car, in the middle of the map, in view.
            const [card, bottom] = [await turnCard.boundingBox(), await sheet.boundingBox()]
            expect(card!.y + card!.height).toBeLessThan(844 / 3)
            expect(bottom!.y).toBeGreaterThan(844 / 2)
            await app.snap('driving on a phone: the next turn, the time left and the arrival')

            await page.getByRole('button', { name: 'More' }).click()
            // The map is a little shorter now: one frame for it to draw at its new size.
            await page.clock.runFor(50)
            // A full light count is a plain number; the distance left; the automatic switch; the voice.
            await expect(sheet.locator('[data-tile="lights"]')).toHaveText(/^Lights on route\d+$/)
            await expect(sheet.locator('[data-tile="distance"]')).toHaveText(/^Distance\d+ mi$/)
            await expect(sheet.locator('[data-tile="auto-switch"]')).toHaveText('Auto-switchOn')
            await expect(sheet).toContainText('Staying: current route is still the fastest · checked')
            await expect(mute).toHaveAttribute('aria-pressed', 'false')
            await app.snap('More: lights, distance, the automatic switch and the voice')
            // Everything tapped is 44px or more.
            for (const button of await sheet.getByRole('button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)

            await mute.click()
            await expect(page.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true')
            await page.getByRole('button', { name: 'Unmute' }).click()
            await page.getByRole('button', { name: 'Less' }).click()
            await expect(mute).toHaveCount(0)
          },
        },
      ],
    })
    expect(log.arrived).toBe(false)

    await page.getByRole('button', { name: 'End' }).click()
    await expect(page.locator('.route-badge', { hasText: 'Recommended' })).toBeVisible()
  })
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
