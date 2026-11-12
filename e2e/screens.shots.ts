import { mkdirSync, writeFileSync } from 'node:fs'
import { EMPTY_PLACE_BOOK, serializePlaceBook, setLastTrip, type Place } from '../src/core/index.ts'
import { PLACE_BOOK_KEY } from '../src/storage/placeBook.ts'
import { expect, test } from './harness.ts'
import { NO_TOKEN_PORT } from './ports.ts'
import { busyMapStyle } from './world/busyMap.ts'
import { JAM_ON_A_FROM_SECOND_CHECK } from './world/traffic.ts'

// Every screen and state of the app, photographed for a design review
// (npm run design:shots; playwright.shots.config.ts). Pictures land in
// design-shots/<project>/<scenario> NN <name>.png. Nothing here is a test of
// behaviour: the e2e scenarios (*.spec.ts) are.

// The pictures may be committed (docs/design) and this repo is public: the Mapbox
// wordmark is hidden in them (the app itself always shows it). The map is the
// harness's blank style or our own busy one (e2e/world/busyMap.ts): no Mapbox map art.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style')
      style.textContent = '.mapboxgl-ctrl-logo { visibility: hidden !important; }'
      document.head.append(style)
    })
  })
})

// Playwright needs the object pattern here, even with no fixtures in it.
// oxlint-disable-next-line no-empty-pattern
test.afterEach(async ({}, info) => {
  const dir = `design-shots/${info.project.name}`
  mkdirSync(dir, { recursive: true })
  const slug = info.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  for (const a of info.attachments) {
    if (a.contentType !== 'image/png' || a.body === undefined) continue
    writeFileSync(`${dir}/${slug} ${a.name.replace(/[^a-z0-9 ]+/gi, '-')}.png`, a.body)
  }
})

test('plan', async ({ app, page }) => {
  await app.open()
  await app.routesReady()
  await app.snap('first screen')
  await page.screenshot({ fullPage: true }).then((body) => test.info().attach('whole page', { body, contentType: 'image/png' }))
  const destination = page.getByRole('combobox', { name: 'Destination' })
  await destination.click()
  await destination.pressSequentially('Bank of Am')
  await expect(page.getByRole('option', { name: /Bank of America Stadium/ })).toBeVisible()
  await app.snap('search suggestions')
  await page.keyboard.press('Escape')
  await page.getByText('Recent and saved places').click()
  await app.snap('saved places open')
  await page.getByRole('button', { name: 'Start drive' }).scrollIntoViewIfNeeded()
  await app.snap('start drive button')
})

test('drive', async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  await app.drive({
    maxSec: 70,
    lookAtSec: [
      {
        atSec: 60,
        look: async () => {
          await app.snap('driving')
          await page.getByRole('button', { name: 'More' }).click()
          await page.clock.runFor(400)
          await app.snap('more open')
          await page.getByRole('button', { name: 'Less' }).click()
        },
      },
    ],
  })
})

test('switch', async ({ app, page }) => {
  app.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
  await app.open({ fakeClock: true })
  await app.routesReady()
  let pendingShot = false
  const looks = Array.from({ length: 400 }, (_, i) => ({
    atSec: 60 + i * 2,
    look: async () => {
      const status = (await page.locator('.live-status').first().textContent()) ?? ''
      if (!pendingShot && status.includes('confirming')) {
        pendingShot = true
        await app.snap('pending: confirming a faster route')
      }
    },
  }))
  // The banner is photographed by the harness the moment it appears.
  const log = await app.drive({ lookAtSec: looks })
  expect(log.banners.length).toBeGreaterThan(0)
  await app.snap('arrived summary after a switch')
  await page.getByRole('button', { name: 'Done' }).click()
})

test('off route', async ({ app }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  await app.drive({ wrongTurnAtSec: 60, maxSec: 90, snapAtSec: [64, 70] })
})

const STONE_MOUNTAIN: Place = { id: 'e2e:stone-mountain', label: 'Stone Mountain Park', position: [-84.1455, 33.8053] }
const CAPITOL: Place = { id: 'e2e:ga-capitol', label: 'Georgia State Capitol', position: [-84.388, 33.749] }

test('signals unknown', async ({ app, page }) => {
  // Outside NC/SC with Overpass busy: every count is unknown.
  const book = setLastTrip(EMPTY_PLACE_BOOK, { origin: STONE_MOUNTAIN, destination: CAPITOL })
  await app.open({ fakeClock: true, storage: { [PLACE_BOOK_KEY]: JSON.stringify(serializePlaceBook(book)) } })
  await app.routesReady()
  await app.snap('routes with unknown lights')
  await page.locator('ol.routes').scrollIntoViewIfNeeded()
  await app.snap('route list, unknown lights')
  await app.drive({
    maxSec: 40,
    lookAtSec: [{ atSec: 30, look: async () => { await page.getByRole('button', { name: 'More' }).click(); await page.clock.runFor(400); await app.snap('more, unknown lights') } }],
  })
})

test('errors', async ({ app, page }) => {
  app.outside.mapboxStatus = 401
  await app.open()
  await expect(page.getByText('Mapbox rejected the token (401)').first()).toBeVisible({ timeout: 15_000 })
  await app.snap('token rejected')
  await page.goto(`http://localhost:${NO_TOKEN_PORT}/`)
  await expect(page.getByText('.env.local').first()).toBeVisible()
  await app.snap('no token')
})

test('iphone shell', async ({ app, page }) => {
  await app.open({ fakeClock: true, shell: true, path: `http://localhost:${NO_TOKEN_PORT}/` })
  await app.snap('shell: paste your token')
  await page.evaluate(() => localStorage.setItem('routeiq.shell.mapboxToken', 'pk.test'))
  await page.reload()
  await app.routesReady()
  await app.snap('shell: plan')
  await page.getByLabel('Test drive (simulated GPS)').check()
  await app.snap('shell: test drive set up')
  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(now + 1000)
  await page.getByRole('button', { name: 'Start drive' }).click()
  await app.settle()
  for (let s = 0; s < 8; s++) {
    await page.clock.fastForward(1000)
    await app.settle()
  }
  await app.snap('shell: simulated GPS badge while driving')
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('button', { name: 'Drive diagnostics' }).click()
  await app.snap('shell: drive diagnostics')
})

// #47: the driving screen over a map as busy as a real street map (e2e/world/busyMap.ts),
// by day and by night: the turn card, the sheet, the route line and the switch's marker.
for (const palette of ['day', 'night'] as const) {
  test(`busy map ${palette}`, async ({ app, page }) => {
    app.outside.mapStyle = busyMapStyle(palette)
    app.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
    // The app picks its map and route colours from the phone's appearance (#145).
    await page.emulateMedia({ colorScheme: palette === 'night' ? 'dark' : 'light' })
    await app.open({ fakeClock: true })
    await app.routesReady()
    await app.snap(`${palette}: trip screen`)
    let pendingShot = false
    const looks = [
      {
        atSec: 60,
        look: async () => {
          await page.clock.runFor(50)
          await app.snap(`${palette}: driving`)
        },
      },
      ...Array.from({ length: 150 }, (_, i) => ({
        atSec: 62 + i * 2,
        look: async () => {
          const status = (await page.locator('.live-status').first().textContent()) ?? ''
          if (!pendingShot && status.includes('confirming')) {
            pendingShot = true
            await page.clock.runFor(50)
            await app.snap(`${palette}: checking a faster route`)
          }
        },
      })),
    ]
    await app.drive({ maxSec: 360, lookAtSec: looks })
  })
}
