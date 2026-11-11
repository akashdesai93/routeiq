import type { ShellWindow } from './browserStubs.ts'
import { expect, test } from './harness.ts'
import { NO_TOKEN_PORT } from './ports.ts'
import { JAM_ON_A_FROM_SECOND_CHECK } from './world/traffic.ts'

// The iPhone shell (native/shell): the same web app inside an installed app,
// built with no token, with the GPS, the voice and the screen lock coming from
// the shell's native plugin. Here the plugin is a stand-in in the page
// (installShellStubs); what iOS itself does with a locked phone can only be
// seen on a phone (docs/phone-install.md).

const SHELL = `http://localhost:${NO_TOKEN_PORT}/`

test('in the iPhone app, I paste my token once, and the drive keeps talking and switches route with the phone locked', async ({ app, page }) => {
  // From the second check on, the direct route jams; the East Loop goes round it.
  app.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
  await app.open({ fakeClock: true, shell: true, path: SHELL })

  // No token is built into the app: it asks for one, and refuses a secret token.
  await expect(page.getByText('Paste your Mapbox public token')).toBeVisible()
  await expect(page.locator('[data-testid="map"]')).toHaveCount(0)
  await page.getByLabel('Paste your Mapbox public token').fill('sk.not-for-a-phone')
  await page.getByRole('button', { name: 'Save token' }).click()
  await expect(page.getByRole('alert')).toContainText('secret token')
  await app.snap('the app asks for a token and refuses a secret one')
  expect(await page.evaluate(() => Object.values({ ...localStorage }).join(' '))).not.toContain('sk.')

  await page.getByLabel('Paste your Mapbox public token').fill('pk.test')
  await page.getByRole('button', { name: 'Save token' }).click()
  await app.routesReady()

  // Once: the next launch opens straight on the map, with a way to change the token.
  await page.reload()
  await app.routesReady()
  await expect(page.getByText('Paste your Mapbox public token')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Change token' })).toBeVisible()
  await app.snap('next launch: the trip, with Change token')

  // Half a minute into the drive the phone is locked, and stays locked to the end.
  const log = await app.drive({ hideAtSec: 30 })
  await app.snap('arrived, after a drive with the phone locked')

  expect(log.arrived).toBe(true)
  // The checks for a faster route went on while locked: the switch needs two of them in a row, after the lock.
  expect(log.banners).toHaveLength(1)
  expect(log.banners[0]!.text).toContain('Switched to a faster route')
  const spoken = await app.spoken()
  expect(spoken[0]).toBe('RouteIQ started')
  expect(spoken.filter((line) => line.startsWith('Switching to a faster route.'))).toHaveLength(1)
  expect(spoken).toContain('Turn left onto East Loop.')
  expect(spoken.at(-1)).toMatch(/^You have arrived\./)

  // All of it through the native plugin: its GPS, its voice, its screen lock. The browser's GPS was never asked.
  const calls = await page.evaluate(() => (window as unknown as ShellWindow).__shell.calls)
  expect(calls).toContain('startLocation')
  expect(calls).toContain('keepAwake:true')
  expect(calls).toContain('speak')
  expect(calls.filter((c) => c.startsWith('BROWSER'))).toEqual([])
  // Arrived: the GPS is let go and the screen may sleep again.
  expect(calls).toContain('stopLocation')
  expect(calls).toContain('keepAwake:false')
})

test('in a browser the same lock pauses the checks for a faster route: that rule is unchanged', async ({ app }) => {
  app.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
  await app.open({ fakeClock: true })
  await app.routesReady()
  // The fake GPS keeps sending here, which a real hidden page would not get; the session still must not ask for routes.
  const log = await app.drive({ hideAtSec: 30, maxSec: 600 })
  const afterLock = app.directionsRequests
  expect(log.banners).toEqual([])
  expect((await app.spoken()).filter((line) => line.startsWith('Switching'))).toEqual([])
  expect(afterLock).toBeLessThanOrEqual(3)
})
