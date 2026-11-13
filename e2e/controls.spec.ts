import { EMPTY_PLACE_BOOK, serializePlaceBook, setLastTrip, type Place } from '../src/core/index.ts'
import { PLACE_BOOK_KEY } from '../src/storage/placeBook.ts'
import type { Locator } from '@playwright/test'
import { expect, test, type App } from './harness.ts'
import { NO_TOKEN_PORT } from './ports.ts'
import { World, type LngLat } from './world/roads.ts'

// Every control, tapped the way a finger does (#203): Playwright's tap on the visible element at
// phone size, never a call into the code. Each scenario says what the driver should then see.
// The controls guard (e2e/controls-guard.mjs) fails when a control is on screen in some
// scenario and no scenario taps it; this file is where most of them are tapped.
//
// Tagged @tap. The file also runs in WebKit, in the webkit-iphone project (playwright.config.ts),
// at 390 x 844 with touch (the size set below overrides the iPhone 14 window there).

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

const SHELL = `http://localhost:${NO_TOKEN_PORT}/`
const UPTOWN = 'Uptown Charlotte (Trade & Tryon)'
const INDIAN_LAND = 'Indian Land, SC (US-521 & SC-160)'

/**
 * Taps a search field and types into it. The tap should select the place already there, so
 * typing replaces it; in WebKit it does not (#217), so the old text is selected with the keyboard
 * first. Remove that line with the fix of #217.
 */
async function typeInto(field: Locator, text: string) {
  await field.tap()
  await field.press('ControlOrMeta+a')
  await field.pressSequentially(text)
}

/** Taps a link that opens another page, and gives back where it went. */
async function tapLink(app: App, name: string | RegExp, within = app.page.locator('body')) {
  const before = app.opened.length
  // The context's new page, not the 'popup' event: a link with rel="noreferrer" opens its page with no opener.
  const opened = app.page.context().waitForEvent('page')
  await within.getByRole('link', { name }).tap()
  await expect.poll(() => app.opened.length).toBe(before + 1)
  // In a new window: the app is still on screen, where it was.
  expect(new URL(app.page.url()).hostname, `after tapping ${String(name)}, the app's page is at ${app.page.url()}`).toBe('localhost')
  await expect(app.page.getByRole('region', { name: 'Plan a trip' })).toBeVisible()
  await (await opened).close()
  return app.opened.at(-1)!
}

test('@tap on the plan screen, each button does what its label says', async ({ app, page }) => {
  await app.open()
  await app.routesReady()
  const origin = page.getByRole('combobox', { name: 'Origin' })
  const destination = page.getByRole('combobox', { name: 'Destination' })
  await expect(origin).toHaveValue(UPTOWN)

  // Use my location: the origin becomes the device's position, and the trip is planned from it.
  // The device is a few streets south-west of the test origin.
  await page.evaluate(() => ((window as unknown as { __e2e: { here: [number, number] } }).__e2e.here = [-80.856, 35.214]))
  const asked = app.directionsRequests
  await page.getByRole('button', { name: 'Use my location' }).tap()
  await expect(origin).toHaveValue('My location')
  await expect.poll(() => app.directionsRequests).toBeGreaterThan(asked)
  await app.routesReady()
  await app.snap('Use my location: the trip starts here')

  // The origin field searches too.
  await typeInto(origin, 'Bank of Am')
  await page.getByRole('option', { name: /Bank of America Stadium/ }).first().tap()
  await expect(origin).toHaveValue(/Bank of America Stadium/)
  await app.routesReady()

  // Reset to test points: back to the built-in trip.
  await page.getByRole('button', { name: 'Reset to test points' }).tap()
  await expect(origin).toHaveValue(UPTOWN)
  await expect(destination).toHaveValue(INDIAN_LAND)
  await app.routesReady()

  // Swap: the two ends change places.
  await page.getByRole('button', { name: 'Swap' }).tap()
  await expect(origin).toHaveValue(INDIAN_LAND)
  await expect(destination).toHaveValue(UPTOWN)
  await page.getByRole('button', { name: 'Swap' }).tap()
  await app.routesReady()

  // A route in the list: tapping the second one selects it, and its hand-off links move with it.
  const rows = page.locator('ol.routes > li')
  const second = rows.nth(1).getByRole('button').first()
  await second.tap()
  await expect(second).toHaveAttribute('aria-pressed', 'true')
  await expect(rows.first().getByRole('button').first()).toHaveAttribute('aria-pressed', 'false')
  await expect(rows.nth(1).getByRole('link', { name: 'Open in Google Maps' })).toBeVisible()
  await expect(rows.first().getByRole('link', { name: 'Open in Google Maps' })).toHaveCount(0)
  await app.snap('the second route selected, its hand-off links under it')

  // The hand-off links open Google Maps and Waze for this trip's destination.
  const google = await tapLink(app, 'Open in Google Maps', rows.nth(1))
  expect(google).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?/)
  expect(decodeURIComponent(google)).toMatch(/[?&]destination=35\.0015\d*,-80\.8561\d*&/)
  // The selected route's own shape goes along, so Google Maps drives that route, not its own pick.
  expect(decodeURIComponent(google)).toMatch(/[?&]waypoints=35\.\d+,-80\.\d+/)
  const waze = await tapLink(app, 'Open in Waze', rows.nth(1))
  expect(decodeURIComponent(waze)).toMatch(/^https:\/\/waze\.com\/ul\?ll=35\.0015\d*,-80\.8561\d*&navigate=yes$/)

  // The signal data credit opens OpenStreetMap's copyright page.
  const credit = await tapLink(app, '© OpenStreetMap contributors', page.getByRole('complementary', { name: 'Routes' }))
  expect(credit).toBe('https://www.openstreetmap.org/copyright')

  // The map's own credit for Mapbox goes where it says. (The signal-data credit beside it is
  // listed in controls-untested.json: tapping it takes the app's own page away, #215.)
  expect(await tapLink(app, 'Mapbox homepage')).toMatch(/^https:\/\/(www\.)?mapbox\.com\//)
})

test('@tap saved places: set, go to, name, rename, remove and clear, each by a tap', async ({ app, page }) => {
  await app.open()
  await app.routesReady()
  const destination = page.getByRole('combobox', { name: 'Destination' })
  const chips = page.getByRole('group', { name: 'Go to a saved place' })
  const more = page.locator('details.plan-more')

  // "Set Home…" opens the place book, where Home is saved.
  await chips.getByRole('button', { name: 'Set Home…' }).tap()
  await expect(more).toHaveAttribute('open', '')
  await expect(more.getByRole('button', { name: 'Save as Home' })).toBeVisible()
  await more.locator('summary').tap()
  await expect(more).not.toHaveAttribute('open', '')
  await chips.getByRole('button', { name: 'Set Work…' }).tap()
  await expect(more).toHaveAttribute('open', '')

  // Which end is saved: Origin, then Destination.
  await more.getByRole('button', { name: 'Origin', exact: true }).tap()
  await expect(more.getByText(`Saving the origin: ${UPTOWN}`)).toBeVisible()
  await more.getByRole('button', { name: 'Destination', exact: true }).tap()
  await expect(more.getByText(`Saving the destination: ${INDIAN_LAND}`)).toBeVisible()
  await more.getByRole('button', { name: 'Save as Home' }).tap()
  await expect(chips.getByRole('button', { name: 'Home', exact: true })).toBeVisible()
  // A searched destination saved as Work (it is a recent destination too, from here on).
  await typeInto(destination, 'Bank of Am')
  await page.getByRole('option', { name: /Bank of America Stadium/ }).first().tap()
  await expect(destination).toHaveValue(/Bank of America Stadium/)
  await app.routesReady()
  await more.getByRole('button', { name: 'Save as Work' }).tap()
  await expect(chips.getByRole('button', { name: 'Work', exact: true })).toBeVisible()
  await app.snap('Home is Indian Land, Work the stadium')

  // A saved place's chip makes it the destination, and the trip goes there.
  const near = (a: LngLat, b: LngLat) => Math.abs(a[0] - b[0]) < 0.005 && Math.abs(a[1] - b[1]) < 0.005
  await chips.getByRole('button', { name: 'Home', exact: true }).tap()
  await expect(destination).toHaveValue('Home')
  await expect.poll(() => app.lastDestination !== null && near(app.lastDestination, [-80.8561, 35.0015])).toBe(true)
  await chips.getByRole('button', { name: 'Work', exact: true }).tap()
  await expect(destination).toHaveValue('Work')
  await expect.poll(() => app.lastDestination !== null && near(app.lastDestination, [-80.8528, 35.2258])).toBe(true)

  // Under a name: the Save button waits for one.
  const name = more.getByRole('textbox', { name: 'Or under a name' })
  const saveNamed = more.locator('form', { has: page.getByRole('textbox', { name: 'Or under a name' }) }).getByRole('button', { name: 'Save' })
  await expect(saveNamed).toBeDisabled()
  await name.tap()
  await name.pressSequentially('Gym')
  await saveNamed.tap()
  await expect(chips.getByRole('button', { name: 'Gym', exact: true })).toBeVisible()
  await expect(name).toHaveValue('')

  // Rename it, then start a rename and cancel it.
  const saved = more.getByRole('list', { name: 'Saved places' })
  await saved.getByRole('listitem').filter({ hasText: 'Gym' }).getByRole('button', { name: 'Rename' }).tap()
  const newName = saved.getByRole('textbox', { name: 'New name for Gym' })
  await newName.tap()
  await newName.fill('')
  await newName.pressSequentially('Pool')
  await saved.getByRole('button', { name: 'Save' }).tap()
  await expect(chips.getByRole('button', { name: 'Pool', exact: true })).toBeVisible()
  await expect(chips.getByRole('button', { name: 'Gym', exact: true })).toHaveCount(0)
  await saved.getByRole('listitem').filter({ hasText: 'Pool' }).getByRole('button', { name: 'Rename' }).tap()
  await saved.getByRole('button', { name: 'Cancel' }).tap()
  await expect(saved.getByRole('textbox')).toHaveCount(0)
  await expect(chips.getByRole('button', { name: 'Pool', exact: true })).toBeVisible()

  // Remove: that place only.
  await saved.getByRole('button', { name: 'Remove Pool' }).tap()
  await expect(chips.getByRole('button', { name: 'Pool', exact: true })).toHaveCount(0)
  await expect(chips.getByRole('button', { name: 'Home', exact: true })).toBeVisible()

  // A recent destination: the stadium, searched above; one tap takes the trip there again.
  await page.getByRole('button', { name: 'Reset to test points' }).tap()
  await expect(destination).toHaveValue(INDIAN_LAND)
  if ((await more.getAttribute('open')) === null) await more.locator('summary').tap()
  await more.getByRole('list', { name: 'Recent destinations' }).getByRole('button', { name: /Bank of America Stadium/ }).tap()
  await expect(destination).toHaveValue(/Bank of America Stadium/)
  await app.snap('a recent destination, one tap')

  // Clear: Cancel keeps everything; Yes, clear removes it all.
  await more.getByRole('button', { name: 'Clear saved places and history' }).tap()
  await more.getByRole('group', { name: 'Confirm clearing' }).getByRole('button', { name: 'Cancel' }).tap()
  await expect(chips.getByRole('button', { name: 'Home', exact: true })).toBeVisible()
  await more.getByRole('button', { name: 'Clear saved places and history' }).tap()
  await more.getByRole('button', { name: 'Yes, clear' }).tap()
  await expect(chips.getByRole('button', { name: 'Set Home…' })).toBeVisible()
  await expect(chips.getByRole('button', { name: 'Set Work…' })).toBeVisible()
  await expect(more.getByText('No recent destinations yet.')).toBeVisible()
  await app.snap('cleared: nothing saved, no recents')
})

test('@tap when the routes cannot be found, Try again finds them', async ({ app, page }) => {
  app.outside.mapboxStatus = 503
  await app.open()
  const panel = page.getByRole('complementary', { name: 'Routes' })
  await expect(panel.getByRole('alert')).toBeVisible({ timeout: 15_000 })
  await app.snap('no routes: the request failed')
  delete app.outside.mapboxStatus
  const asked = app.directionsRequests
  await panel.getByRole('button', { name: 'Try again' }).tap()
  await app.routesReady()
  expect(app.directionsRequests).toBe(asked + 1)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('ol.routes > li')).toHaveCount(3)
})

// Public landmarks in Georgia, outside the bundled NC/SC signal tiles (as in signals.spec.ts).
const STONE_MOUNTAIN: Place = { id: 'e2e:stone-mountain', label: 'Stone Mountain Park', position: [-84.1455, 33.8053] }
const CAPITOL: Place = { id: 'e2e:ga-capitol', label: 'Georgia State Capitol', position: [-84.388, 33.749] }

test('@tap when part of the signal data could not be loaded, Retry signals fills it in', async ({ app, page }) => {
  const book = setLastTrip(EMPTY_PLACE_BOOK, { origin: STONE_MOUNTAIN, destination: CAPITOL })
  const corner = new World(STONE_MOUNTAIN.position as LngLat, CAPITOL.position as LngLat).cornersOf('A')[1]!
  // Overpass is busy for the western tiles until the retry, then answers every tile.
  let busy = true
  app.outside.overpass = (query) => {
    const box = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/.exec(query)
    if (box === null) return { status: 400 }
    const [south, west, north, east] = box.slice(1).map(Number) as [number, number, number, number]
    if (busy && west < -84.3) return { status: 504 }
    const [lng, lat] = corner
    const inside = lat >= south && lat <= north && lng >= west && lng <= east
    return { status: 200, body: { version: 0.6, generator: 'e2e', elements: inside ? [{ type: 'node', id: 901, lat, lon: lng, tags: { highway: 'traffic_signals' } }] : [] } }
  }
  await app.open({ fakeClock: true, storage: { [PLACE_BOOK_KEY]: JSON.stringify(serializePlaceBook(book)) } })
  await app.routesReady()
  const counts = page.locator('.route-signals')
  await expect(counts.first()).toHaveText(/partial|unknown/)
  await app.snap('partial signal counts, with Retry signals')

  // After a busy answer the client sends nothing for a while (providers/osm/client.ts); the
  // message says "Try again in a minute", and a minute later the driver does.
  busy = false
  await page.clock.fastForward(61_000)
  await page.getByRole('button', { name: 'Retry signals' }).tap()
  await expect(page.getByRole('button', { name: 'Retry signals' })).toHaveCount(0, { timeout: 15_000 })
  await app.routesReady()
  for (const text of await counts.allTextContents()) expect(text).toMatch(/^\d+ signals?$/)
  await app.snap('after Retry signals: whole counts')
})

test('@tap the Drives screen: Close goes back, Copy copies the log, and Cancel keeps it', async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  await app.drive({ maxSec: 90 })
  await page.getByRole('button', { name: 'End' }).tap()
  await page.getByRole('button', { name: /^Drives/ }).tap()
  const screen = page.getByRole('region', { name: 'Drives' })
  await expect(screen.getByRole('list', { name: 'Past drives' }).getByRole('listitem')).toHaveCount(1)

  await screen.getByRole('button', { name: 'Export' }).tap()
  await screen.getByRole('button', { name: 'Copy' }).tap()
  await expect(screen.getByRole('status')).toHaveText(/^(Copied\. Paste it into a message or a spreadsheet\.|Could not copy\. Press and hold the text, Select All, then Copy\.)$/)
  await app.snap('Drives: the log copied')

  // Clear asks first; Cancel keeps the drive.
  await screen.getByRole('button', { name: 'Clear drive log' }).tap()
  await screen.getByRole('button', { name: 'Cancel' }).tap()
  await expect(screen.getByRole('list', { name: 'Past drives' }).getByRole('listitem')).toHaveCount(1)
  await expect(screen.getByRole('button', { name: 'Clear drive log' })).toBeVisible()

  // Close: back to the plan screen, the count on the button.
  await screen.getByRole('button', { name: 'Close' }).tap()
  await expect(screen).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Drives (1)' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start drive' })).toBeVisible()
})

test('@tap a double tap on Start drive starts one drive and does not end it', async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  const start = page.getByRole('button', { name: 'Start drive' })
  await start.scrollIntoViewIfNeeded()
  const box = (await start.boundingBox())!
  // Two taps on the same spot, as fast as a finger: the second lands on whatever replaced the button.
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
  await page.clock.runFor(2000)
  const drive = page.getByRole('region', { name: 'Live drive' })
  await expect(drive).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'End' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start drive' })).toHaveCount(0)
  await app.snap('after a double tap on Start drive: one drive, still on')
  // One End is enough: there was only one drive to end.
  await page.getByRole('button', { name: 'End' }).tap()
  await expect(drive).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start drive' })).toBeVisible()
})

test('@tap when the drive cannot go on, Close goes back to the plan screen', async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  await app.drive({ maxSec: 60 })
  await page.evaluate(() => (window as unknown as { __e2e: { deny: () => void } }).__e2e.deny())
  const failed = page.getByRole('region', { name: 'Live drive' })
  await expect(failed.getByRole('alert')).toBeVisible()
  await failed.getByRole('button', { name: 'Close' }).tap()
  await expect(failed).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start drive' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Destination' })).toHaveValue(INDIAN_LAND)
})

test('@tap the simulated drive: open it, pick a speed, start, pause, resume and stop', async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  const panel = page.getByRole('region', { name: 'Simulated drive' })
  // On a phone it starts folded away.
  await expect(panel.getByRole('button', { name: 'Start simulated drive' })).toBeHidden()
  await panel.locator('summary', { hasText: 'Simulate drive' }).tap()
  const speeds = panel.getByRole('group', { name: 'Simulation speed' }).getByRole('button')
  const last = speeds.last()
  await last.tap()
  await expect(last).toHaveAttribute('aria-pressed', 'true')
  await expect(speeds.first()).toHaveAttribute('aria-pressed', 'false')

  await panel.getByRole('button', { name: 'Start simulated drive' }).tap()
  const status = panel.locator('.drive-status')
  await expect(status).toContainText(/Driving|Checking routes/)
  await page.clock.runFor(3000)
  await panel.getByRole('button', { name: 'Pause' }).tap()
  await expect(status).toContainText('Paused')
  const pausedAt = await status.textContent()
  await page.clock.runFor(3000)
  await expect(status).toHaveText(pausedAt!)
  await panel.getByRole('button', { name: 'Resume' }).tap()
  await expect(status).not.toContainText('Paused')
  await app.snap('the simulated drive, resumed')
  await panel.getByRole('button', { name: 'Stop' }).tap()
  await expect(status).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Start simulated drive' })).toBeVisible()
})

test('@tap the reroute settings take what I type, say it, and Reset to defaults puts them back', async ({ app, page }) => {
  await app.open()
  await app.routesReady()
  const panel = page.getByRole('region', { name: 'Simulated drive' })
  await panel.locator('summary', { hasText: 'Simulate drive' }).tap()
  const settings = panel.locator('details.drive-settings')
  await settings.locator('summary').tap()
  const fields = settings.getByRole('spinbutton')
  const count = await fields.count()
  expect(count).toBeGreaterThanOrEqual(10)
  const defaults: string[] = []
  for (let i = 0; i < count; i++) {
    const field = fields.nth(i)
    defaults.push(await field.inputValue())
    await field.tap()
    await field.fill('77')
    await expect(field).toHaveValue('77')
  }
  // The two the panel puts in words: how often it checks and how many requests a drive may use.
  await expect(panel.getByText(/every 77 s of simulated time/)).toBeVisible()
  await expect(panel.getByText(/and 77 per drive/)).toBeVisible()
  await app.snap('every reroute setting typed as 77')
  await settings.getByRole('button', { name: 'Reset to defaults' }).tap()
  for (let i = 0; i < count; i++) await expect(fields.nth(i)).toHaveValue(defaults[i]!)
})

test('@tap the map: zoom in, zoom out, back to north, and a tapped pin says what it is', async ({ app, page }) => {
  await app.open()
  await app.routesReady()
  const canvas = page.locator('canvas.mapboxgl-canvas')
  const look = () => canvas.screenshot()
  const before = await look()
  await page.getByRole('button', { name: 'Zoom in' }).tap()
  await expect.poll(async () => Buffer.compare(await look(), before) !== 0).toBe(true)
  const zoomedIn = await look()
  await page.getByRole('button', { name: 'Zoom out' }).tap()
  await expect.poll(async () => Buffer.compare(await look(), zoomedIn) !== 0).toBe(true)
  // Back to north: already north, so the map stays as it is and nothing breaks.
  await page.getByRole('button', { name: 'Reset bearing to north' }).tap()
  await expect(page.locator('ol.routes > li')).toHaveCount(3)

  // A pin, tapped: it says which end of the trip it is.
  const pins = page.locator('.mapboxgl-marker')
  await expect(pins).toHaveCount(2)
  await pins.nth(1).tap()
  await expect(page.locator('.mapboxgl-popup')).toContainText(INDIAN_LAND)
  await app.snap('the destination pin, tapped: its label')
  await page.getByRole('button', { name: 'Close popup' }).tap()
  await expect(page.locator('.mapboxgl-popup')).toHaveCount(0)
})

test('@tap in the iPhone app: Change token and Cancel, and the test drive presets and speeds', async ({ app, page }) => {
  await app.open({ shell: true, path: SHELL, storage: { 'routeiq.shell.mapboxToken': 'pk.test' } })
  await app.routesReady()

  // Change token, then Cancel: back to the app, the token unchanged.
  await page.getByRole('button', { name: 'Change token' }).tap()
  await expect(page.getByLabel('Paste your Mapbox public token')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).tap()
  await expect(page.getByLabel('Paste your Mapbox public token')).toHaveCount(0)
  await app.routesReady()

  // The test drive: each preset and speed says what it will do.
  await page.getByLabel('Test drive (simulated GPS)').tap()
  const presets = page.getByRole('group', { name: 'What the test drive does' })
  for (const button of await presets.getByRole('button').all()) {
    await button.tap()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(presets.getByRole('button', { pressed: true })).toHaveCount(1)
  }
  await page.getByRole('button', { name: 'Follow the route' }).tap()
  await expect(page.getByRole('button', { name: 'Follow the route' })).toHaveAttribute('aria-pressed', 'true')
  const speeds = page.getByRole('group', { name: 'Test drive speed' })
  for (const button of await speeds.getByRole('button').all()) {
    await button.tap()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
  }
  await page.getByLabel('Test drive (simulated GPS)').tap()
  await expect(presets).toHaveCount(0)
})


test('the controls guard counts a tap, never a click made in code', async ({ app, page }) => {
  await app.open()
  await app.routesReady()
  const swap = 'Plan a trip › button "Swap"'
  const origin = page.getByRole('combobox', { name: 'Origin' })
  // A click from the page's own code: the trip swaps, but nobody tapped anything.
  await page.getByRole('button', { name: 'Swap' }).evaluate((button) => (button as HTMLButtonElement).click())
  await expect(origin).toHaveValue(INDIAN_LAND)
  await expect.poll(() => app.controls.seen.has(swap)).toBe(true)
  expect(app.controls.activated.has(swap)).toBe(false)
  // A real tap.
  await page.getByRole('button', { name: 'Swap' }).tap()
  await expect(origin).toHaveValue(UPTOWN)
  await expect.poll(() => app.controls.activated.has(swap)).toBe(true)
})
