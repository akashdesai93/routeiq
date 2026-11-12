import type { ShellWindow } from './browserStubs.ts'
import { expect, test } from './harness.ts'
import { NO_TOKEN_PORT } from './ports.ts'
import { JAM_ON_A_FROM_SECOND_CHECK } from './world/traffic.ts'

// The private drive log (#107): each live drive is kept on the device with
// the time RouteIQ predicted at the start and the time it really took, under
// a coarse corridor key (never a position or an address). The Drives screen
// opens from the plan screen.

/** The one key the log lives under (src/storage/driveLog.ts). */
const LOG_KEY = 'routeiq.drives.v1'

/** Anything that looks like a coordinate: a number with four or more decimals. */
const COORDINATE = /-?\d{1,3}\.\d{4,}/

test('after a drive, it shows how long it really took against what it predicted', async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  // Before leaving, the owner notes what another app said for the same trip.
  await page.getByLabel("Other app's ETA (minutes)").fill('19')
  await app.snap('the trip, with the other app’s ETA noted')
  const log = await app.drive()
  expect(log.arrived).toBe(true)
  await page.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: /^Drives/ }).click()
  const screen = page.getByRole('region', { name: 'Drives' })
  await expect(screen).toBeVisible()
  const drive = screen.getByRole('list', { name: 'Past drives' }).getByRole('listitem').first()
  // The plan's answer for the Main Corridor said 19.5 min; the drive took 17.
  await expect(drive).toContainText('Predicted 19 min · Took 17 min (2 min shorter than predicted)')
  await expect(drive).toContainText('Other app 19 min')
  await expect(drive).toContainText('Arrived')
  await expect(drive).toContainText('Corridor A')
  await expect(screen.getByRole('table', { name: 'Corridor A by hour' })).toContainText('8 am')
  await app.snap('the Drives screen: predicted against actual')

  // What is kept: a versioned record with no coordinates and no place names.
  const stored = await page.evaluate((key) => localStorage.getItem(key), LOG_KEY)
  expect(stored).not.toBeNull()
  expect(JSON.parse(stored!)).toMatchObject({ version: 1 })
  expect(stored).not.toMatch(COORDINATE)
  expect(stored).not.toMatch(/Uptown|Indian Land|Charlotte|SC-160|US-521/i)

  // It is still there after the app is closed and opened again.
  await page.reload()
  await app.routesReady()
  await page.getByRole('button', { name: /^Drives/ }).click()
  await expect(page.getByRole('list', { name: 'Past drives' }).getByRole('listitem')).toHaveCount(1)

  // Export: the same log as CSV text, to copy or share.
  await page.getByRole('button', { name: 'Export' }).click()
  const csv = page.getByLabel('Drive log as CSV')
  await expect(csv).toHaveValue(/^started,corridor,hour,outcome,route_source,predicted_min,actual_min,error_min,other_app_min/)
  await expect(csv).toHaveValue(/,A,8,arrived,provider,19\.\d,17\.\d,-[12]\.\d,19\.0,/)
  await expect(csv).not.toHaveValue(COORDINATE)
  await app.snap('export: the log as CSV')

  // Clear: asked once, then the device keeps nothing.
  await page.getByRole('button', { name: 'Clear drive log' }).click()
  await page.getByRole('button', { name: 'Yes, clear it' }).click()
  await expect(page.getByRole('region', { name: 'Drives' })).toContainText('No drives yet')
  expect(await page.evaluate((key) => localStorage.getItem(key), LOG_KEY)).toBeNull()
  await app.snap('after Clear: nothing kept')
})

test('a switch it made is in the log, with the saving it claimed and the saving it really made', async ({ app, page }) => {
  app.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
  await app.open({ fakeClock: true })
  await app.routesReady()
  const log = await app.drive()
  expect(log.arrived).toBe(true)
  expect(log.banners).toHaveLength(1)
  await page.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: /^Drives/ }).click()
  const drive = page.getByRole('list', { name: 'Past drives' }).getByRole('listitem').first()
  await expect(drive).toContainText('1 switch')
  await expect(drive).toContainText(/claimed \d+ min, made [−-]?\d+ min/)
  await app.snap('the Drives screen: a drive with a switch')
})

test('a drive ended before arriving is kept as ended, and is left out of the corridor summary', async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  await app.drive({ maxSec: 120 })
  await page.getByRole('button', { name: 'End' }).click()

  await page.getByRole('button', { name: /^Drives/ }).click()
  const screen = page.getByRole('region', { name: 'Drives' })
  await expect(screen.getByRole('list', { name: 'Past drives' }).getByRole('listitem').first()).toContainText('Ended early')
  await expect(screen).toContainText('No arrived drives yet')
  await app.snap('the Drives screen: a drive ended early')
})

test('in the iPhone app, the drive log is kept on the phone across launches', async ({ app, page }) => {
  await app.open({ fakeClock: true, shell: true, path: `http://localhost:${NO_TOKEN_PORT}/` })
  await page.getByLabel('Paste your Mapbox public token').fill('pk.test')
  await page.getByRole('button', { name: 'Save token' }).click()
  await app.routesReady()
  const log = await app.drive({ hideAtSec: 30 })
  expect(log.arrived).toBe(true)
  await page.getByRole('button', { name: 'Done' }).click()

  // The next launch of the app: the drive is still there, written through the shell's web storage.
  await page.reload()
  await app.routesReady()
  await page.getByRole('button', { name: 'Drives (1)' }).click()
  const drive = page.getByRole('list', { name: 'Past drives' }).getByRole('listitem')
  await expect(drive).toHaveCount(1)
  await expect(drive).toContainText('Arrived')
  await expect(drive).toContainText(/Predicted \d+ min · Took 1[67] min/)
  await app.snap('in the iPhone app: the Drives screen after a drive with the phone locked')
  const stored = await page.evaluate((key) => localStorage.getItem(key), LOG_KEY)
  expect(stored).not.toMatch(COORDINATE)
  expect(stored).not.toContain('pk.')

  // Export: Share opens the phone's own share sheet (the shell plugin) with the CSV.
  await page.getByRole('button', { name: 'Export' }).click()
  await page.getByRole('button', { name: 'Share' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as ShellWindow).__shell.shared)).toHaveLength(1)
  const shared = (await page.evaluate(() => (window as unknown as ShellWindow).__shell.shared))[0]!
  expect(shared).toMatch(/^started,corridor,hour,outcome/)
  expect(shared.split('\n')).toHaveLength(2)
  expect(shared).not.toMatch(COORDINATE)
})

test('when location is taken away mid-drive and I tap Try again, the drive so far is kept as ended', async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  await app.drive({ maxSec: 120 })
  // Two minutes in, location permission is withdrawn: the drive cannot go on.
  await page.evaluate(() => (window as unknown as { __e2e: { deny: () => void } }).__e2e.deny())
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await app.snap('location withdrawn: the drive cannot go on')
  await page.getByRole('button', { name: 'Try again' }).click()
  // The new attempt never gets a position; the driver gives up on it.
  await page.getByRole('button', { name: 'End' }).click()

  await page.getByRole('button', { name: /^Drives/ }).click()
  const drives = page.getByRole('list', { name: 'Past drives' }).getByRole('listitem')
  await expect(drives).toHaveCount(1)
  await expect(drives.first()).toContainText('Ended early')
  await expect(drives.first()).toContainText('Took 2 min')
})
