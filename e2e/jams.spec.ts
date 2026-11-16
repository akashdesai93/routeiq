import { expect, test } from './harness.ts'
import { NO_TOKEN_PORT } from './ports.ts'
import { crawling } from './world/crawl.ts'
import { JAM_WHERE_ALL_THREE_SHARE } from './world/traffic.ts'

// Jam minutes (#227, docs/jam-bypass.md): during a live drive the phone measures how long the
// car crawls (under about 15 mph, for 30 s or more) on main roads, and the Drives screen shows
// it per drive and per corridor. It is the most a side-street bypass could ever have won, and
// the number the jam-bypass direction is kept or scrapped by. Kept on the device only, with no
// position.
//
// The made-up roads say what they are, as Mapbox does: Main Corridor and the two loops are
// main roads, Parallel Street's own stretch is a local street.

const LOG_KEY = 'routeiq.drives.v1'
/** Anything that looks like a coordinate: a number with four or more decimals. */
const COORDINATE = /-?\d{1,3}\.\d{4,}/
/** About 9 mph: well under the 15 mph of a jam. */
const CRAWL_MPS = 4

test('after a drive, it shows how long I crawled in jams on the main road', async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  // Three minutes of crawling on Main Corridor two minutes in, then, later, 20 s of slowing down.
  const log = await app.drive({
    speedMps: crawling([
      { fromSec: 120, forSec: 180, mps: CRAWL_MPS },
      { fromSec: 500, forSec: 20, mps: CRAWL_MPS },
    ]),
  })
  expect(log.arrived).toBe(true)
  await page.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: /^Drives/ }).click()
  const screen = page.getByRole('region', { name: 'Drives' })
  const drive = screen.getByRole('list', { name: 'Past drives' }).getByRole('listitem').first()
  // The three minutes are one jam; the 20 s are not a jam.
  await expect(drive.getByLabel('Jams', { exact: true })).toHaveText('In jams on main roads: 3 min in 1 jam')
  // Per corridor: the average per drive, which the kill line (about 5 min) is read against.
  await expect(screen.getByRole('region', { name: 'Corridor A' }).getByLabel('Jams per drive')).toHaveText(
    'In jams on main roads: 3.0 min per drive on average (1 drive)',
  )
  await app.snap('the Drives screen: 3 min in 1 jam on the main road, and the average per drive')

  // Kept on the device with no position: seconds, and meters into the drive to the nearest 100.
  const stored = await page.evaluate((key) => localStorage.getItem(key), LOG_KEY)
  expect(stored).not.toMatch(COORDINATE)
  const record = (JSON.parse(stored!) as { drives: { jams: unknown }[] }).drives[0]!
  // Two minutes at 25 m/s before the crawl: 3 km in.
  expect(record.jams).toEqual({ list: [{ atSec: 120, durationSec: 180, drivenM: 3000 }], count: 1, jamSec: 180, unknownSec: 0 })

  // Export: jam_min is the last column.
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByLabel('Drive log as CSV')).toHaveValue(/,requests,jam_min\n.*,3\.0$/)
})

test('crawling on a side street is not a jam on the main road', async ({ app, page }) => {
  // Parallel Street is the fastest way (a jam where Mapbox's three routes run) and the driver takes it.
  app.outside.sideStreet = true
  app.outside.traffic = JAM_WHERE_ALL_THREE_SHARE
  await app.open({ fakeClock: true })
  await expect(page.locator('.route-source', { hasText: 'Side streets' })).toBeVisible({ timeout: 15_000 })
  await app.routesReady()
  await expect(page.locator('ol.routes > li').first().getByRole('button')).toHaveAttribute('aria-pressed', 'true')

  // One minute of crawling on Main Corridor before the side street begins (it begins a quarter
  // of the way, about 4 minutes in), then three minutes of crawling on Parallel Street itself.
  const log = await app.drive({
    road: 'S',
    speedMps: crawling([
      { fromSec: 60, forSec: 60, mps: CRAWL_MPS },
      { fromSec: 420, forSec: 180, mps: CRAWL_MPS },
    ]),
  })
  expect(log.arrived).toBe(true)
  await page.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: /^Drives/ }).click()
  const drive = page.getByRole('list', { name: 'Past drives' }).getByRole('listitem').first()
  // Only the minute on the main road counts.
  await expect(drive.getByLabel('Jams', { exact: true })).toHaveText('In jams on main roads: 1 min in 1 jam')
  await app.snap('the Drives screen: a crawl on Parallel Street adds no jam time')
})

test('where the kind of road is not known, jam time is unknown, never none', async ({ app, page }) => {
  // Mapbox's answers say nothing about the class of the roads.
  app.outside.roadClasses = false
  await app.open({ fakeClock: true })
  await app.routesReady()
  const log = await app.drive({ speedMps: crawling([{ fromSec: 120, forSec: 180, mps: CRAWL_MPS }]) })
  expect(log.arrived).toBe(true)
  await page.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: /^Drives/ }).click()
  const screen = page.getByRole('region', { name: 'Drives' })
  const drive = screen.getByRole('list', { name: 'Past drives' }).getByRole('listitem').first()
  await expect(drive.getByLabel('Jams', { exact: true })).toHaveText('In jams on main roads: unknown')
  // The drive is left out of the average, not counted as 0 minutes.
  await expect(screen.getByRole('region', { name: 'Corridor A' }).getByLabel('Jams per drive')).toHaveText(
    'In jams on main roads: no measured drives yet (1 with unknown jam time left out)',
  )
  await app.snap('the Drives screen: jam time unknown where the kind of road is not known')
  // In the export the cell is blank, not 0.
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByLabel('Drive log as CSV')).toHaveValue(/,requests,jam_min\n.*,\d+,$/)
})

test('in the iPhone app, the drive diagnostics say how long I crawled in jams', async ({ app, page }) => {
  await app.open({ fakeClock: true, shell: true, path: `http://localhost:${NO_TOKEN_PORT}/`, storage: { 'routeiq.shell.mapboxToken': 'pk.test' } })
  await app.routesReady()
  // A minute of crawling on Main Corridor, then End.
  await app.drive({ speedMps: crawling([{ fromSec: 60, forSec: 60, mps: CRAWL_MPS }]), maxSec: 200 })
  await page.getByRole('button', { name: 'End' }).click()

  await page.getByRole('button', { name: 'Drive diagnostics' }).click()
  const diagnostics = await page.getByLabel('Diagnostics text').inputValue()
  expect(diagnostics.split('\n')).toContain('in jams on main roads (latest drive): 1 min in 1 jam')
  // Counts and timings only, as before: no decimals, so no position.
  expect(diagnostics).not.toMatch(/\d\.\d/)
  await app.snap('drive diagnostics: the jam line')
})
