import type { ShellWindow } from './browserStubs.ts'
import { amberOutside, smallText } from './design.ts'
import { expect, test, type App } from './harness.ts'
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
  // Before that: the top bar is gone while driving, and Drive diagnostics is still one tap behind More.
  const log = await app.drive({
    hideAtSec: 30,
    lookAtSec: [
      {
        atSec: 20,
        look: async () => {
          await page.getByRole('button', { name: 'More' }).click()
          await page.getByRole('button', { name: 'Drive diagnostics' }).click()
          await expect(page.getByLabel('Diagnostics text')).toBeVisible()
          await app.snap('driving in the iPhone app: Drive diagnostics from More')
          await page.getByRole('button', { name: 'Close' }).click()
          await page.getByRole('button', { name: 'Less' }).click()
          await expect(page.getByRole('button', { name: 'End' })).toBeVisible()
        },
      },
    ],
  })
  await app.snap('arrived, after a drive with the phone locked')

  expect(log.arrived).toBe(true)
  // The checks for a faster route went on while locked: the switch needs two of them in a row, after the lock.
  expect(log.banners).toHaveLength(1)
  expect(log.banners[0]!.text).toContain('Switching to a faster route')
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
  // The route requests went out through the plugin's native networking; none straight from the page
  // (that would be among the BROWSER calls above).
  expect(calls.filter((c) => c === 'httpGet').length).toBeGreaterThanOrEqual(3)

  // After the drive: Drive diagnostics says what the phone let the app do, in counts and timings only.
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Drive diagnostics' }).click()
  const diagnostics = await page.getByLabel('Diagnostics text').inputValue()
  await app.snap('drive diagnostics after the drive')
  expect(diagnostics).toMatch(/requests: [1-9]\d* sent \([1-9]\d* while not active\), [1-9]\d* answered, 0 failed/)
  expect(diagnostics).toMatch(/fixes: \d+ \([1-9]\d* while not active\)/)
  expect(diagnostics).toMatch(/request \d+ answered, HTTP 200, \d+ ms, native \d+ ms \[background\]/)
  expect(diagnostics).toContain('app background')
  // What the drive's checks concluded, so "was there a faster way?" has an answer afterwards.
  // This drive switched once, after one check to confirm it: the tally says so, and how much faster it was.
  const checks = diagnostics.split('\n').find((l) => l.startsWith('checks: ')) ?? ''
  expect(checks).toContain('a faster one, waiting for the next check to confirm it 1')
  expect(checks).toContain('switched to a faster one 1')
  expect(diagnostics).toMatch(/best saving another route offered: [1-9]\d* s/)
  // What became of the offer (#202): shown, then confirmed by the app's next check, and the turns moved with it.
  expect(diagnostics).toMatch(/offer shown: a faster one, waiting for the next check to confirm it \(saves [1-9]\d* s\)/)
  expect(diagnostics).toMatch(/offer confirmed by the app after [1-9]\d* s, directions changed/)
  expect(diagnostics).toContain('offers: 1 shown: taken 0, kept 0, confirmed 1, withdrawn 0, expired 0, directions unchanged 0')
  expect(diagnostics).not.toMatch(/\d\.\d|pk\.|https?:/)
  await page.getByRole('button', { name: 'Copy' }).click()
  await expect(page.getByText('Copied. Paste it into a message.')).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByLabel('Diagnostics text')).toHaveCount(0)
})

/** The iPhone app with a token saved, on the trip screen, with `traffic` on the roads. */
async function shellReady(app: App, traffic: typeof JAM_ON_A_FROM_SECOND_CHECK) {
  app.outside.traffic = traffic
  await app.open({ fakeClock: true, shell: true, path: SHELL })
  await app.page.getByLabel('Paste your Mapbox public token').fill('pk.test')
  await app.page.getByRole('button', { name: 'Save token' }).click()
  await app.routesReady()
}

/** The Drive diagnostics text, after the drive. */
async function diagnosticsAfter(app: App) {
  const page = app.page
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Drive diagnostics' }).click()
  return page.getByLabel('Diagnostics text').inputValue()
}

test('in the iPhone app, when I take a faster route on offer, the diagnostics say I took it, how soon, and that the directions changed', async ({ app }) => {
  await shellReady(app, JAM_ON_A_FROM_SECOND_CHECK)
  const log = await app.drive({ takeIt: true })
  expect(log.arrived).toBe(true)
  expect(log.moments.map((m) => m.stage).slice(0, 2)).toEqual(['pending', 'confirmed'])
  const diagnostics = await diagnosticsAfter(app)
  await app.snap('diagnostics after taking the offer: shown, then taken by the driver, directions changed')
  const offerLines = diagnostics.split('\n').filter((l) => / offer (shown|taken|kept|confirmed|withdrawn|expired)/.test(l))
  expect(offerLines).toHaveLength(2)
  expect(offerLines[0]).toMatch(/offer shown: a faster one, waiting for the next check to confirm it \(saves [1-9]\d* s\)/)
  expect(offerLines[1]).toMatch(/offer taken by the driver after \d+ s, directions changed/)
  expect(diagnostics).toContain('offers: 1 shown: taken 1, kept 0, confirmed 0, withdrawn 0, expired 0, directions unchanged 0')
  expect(diagnostics).not.toMatch(/\d\.\d|pk\.|https?:/)
})

test('in the iPhone app, when I keep my route while a faster one is on offer, the diagnostics say I kept it', async ({ app }) => {
  await shellReady(app, JAM_ON_A_FROM_SECOND_CHECK)
  const log = await app.drive({ keepMyRoute: 'pending' })
  expect(log.arrived).toBe(true)
  const diagnostics = await diagnosticsAfter(app)
  await app.snap('diagnostics after keeping my route: shown, then kept by the driver')
  const offerLines = diagnostics.split('\n').filter((l) => / offer (shown|taken|kept|confirmed|withdrawn|expired)/.test(l))
  expect(offerLines[0]).toMatch(/offer shown: /)
  // Kept is the whole story of that offer: its one ending, with no switch logged for it.
  expect(offerLines[1]).toMatch(/offer kept by the driver after \d+ s \[/)
  // Ten minutes on, the same route is still faster: offered again as a new offer, which the app confirms.
  expect(offerLines).toHaveLength(4)
  expect(offerLines[2]).toMatch(/offer shown: /)
  expect(offerLines[3]).toMatch(/offer confirmed by the app after [1-9]\d* s, directions changed/)
  expect(diagnostics).toContain('offers: 2 shown: taken 0, kept 1, confirmed 1, withdrawn 0, expired 0, directions unchanged 0')
})

test('at home, a test drive with a wrong turn says I am off the route and finds a new one with the phone locked, and its diagnostics are still there after the app was closed', async ({ app, page }) => {
  // The token is on the phone already (the scenario above covers pasting it).
  await app.open({ fakeClock: true, shell: true, path: SHELL, storage: { 'routeiq.shell.mapboxToken': 'pk.test' } })
  await app.routesReady()

  // On the trip screen: a clearly labelled test drive, with what it does and how fast.
  await page.getByLabel('Test drive (simulated GPS)').check()
  await expect(page.getByText('The route requests to Mapbox are real and count against the request budget.')).toBeVisible()
  await page.getByRole('button', { name: 'Wrong turn after 1 min' }).click()
  await page.getByRole('button', { name: '3× speed' }).click()
  await app.snap('the test drive, set to a wrong turn at 3x speed')

  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(now + 1000)
  await page.getByRole('button', { name: 'Start drive' }).click()
  await app.settle()

  const banners: { atSec: number; text: string }[] = []
  let lastBanner = ''
  let arrived = false
  for (let sec = 1; sec <= 1500 && !arrived; sec++) {
    if (sec === 5) {
      // The phone is locked, and stays locked.
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      })
    }
    if (sec === 8) {
      // The drive view says the position is made up, and has a way to the diagnostics without ending the drive.
      const badge = page.getByText('SIMULATED GPS', { exact: true })
      await expect(badge).toBeVisible()
      await app.snap('test drive: the SIMULATED GPS badge')
      // A test-mode label is not news: no amber (amber means a faster route), and driving-size text (#133).
      expect(await amberOutside(badge, '.live-banner'), 'amber on the SIMULATED GPS badge').toEqual([])
      expect(await smallText(badge, 14), 'SIMULATED GPS badge text under 14 px').toEqual([])
      await page.getByRole('button', { name: 'More' }).click()
      await page.getByRole('button', { name: 'Drive diagnostics' }).click()
      await expect(page.getByLabel('Diagnostics text')).toHaveValue(/SIMULATED GPS test drive: wrong-turn, 3x speed/)
      await app.snap('during the test drive: SIMULATED GPS, and the diagnostics on top')
      await page.getByRole('button', { name: 'Close' }).click()
      await page.getByRole('button', { name: 'Less' }).click()
      await expect(page.getByRole('button', { name: 'End' })).toBeVisible()
      await expect(page.getByText('SIMULATED GPS', { exact: true })).toBeVisible()
    }
    // The phone's real GPS (it is at home, far from the route) keeps reporting; none of it reaches the drive.
    if (sec % 10 === 0) await page.evaluate(() => (window as unknown as { __e2e: { fix: (...a: number[]) => void } }).__e2e.fix(-80.9, 35.3, 0, 0))
    await page.clock.fastForward(1000)
    const state = await app.settle()
    if (state.banner !== '' && state.banner !== lastBanner) {
      banners.push({ atSec: sec, text: state.banner })
      await app.snap(`second ${sec}: ${state.banner}`)
    }
    lastBanner = state.banner
    arrived = state.arrived
  }
  await app.snap('arrived, after the test drive')

  // The wrong turn came 20 s in (a minute of road at 3x), was called, and a new route was found; then the car followed it there.
  expect(arrived).toBe(true)
  expect(banners).toHaveLength(1)
  expect(banners[0]!.text).toContain('New route')
  expect(banners[0]!.atSec).toBeGreaterThan(20)
  expect(banners[0]!.atSec).toBeLessThan(45)
  const spoken = await app.spoken()
  expect(spoken.slice(0, 3)).toEqual([
    'RouteIQ started',
    'You are off the route. Finding a new one.',
    expect.stringMatching(/^New route\. \d+ minutes to your destination\.$/),
  ])
  expect(spoken.filter((line) => line === 'You are off the route. Finding a new one.')).toHaveLength(1)
  expect(spoken.at(-1)).toMatch(/^You have arrived\./)

  // The made-up car was moved by the plugin (twice: the route, then the new route, after standing at the start),
  // with the real GPS switched on as on a real drive, and both were let go at the end.
  const calls = await page.evaluate(() => (window as unknown as ShellWindow).__shell.calls)
  expect(calls.filter((c) => c === 'startSimulatedRoute')).toHaveLength(3)
  expect(calls.indexOf('startSimulatedRoute')).toBeLessThan(calls.indexOf('startLocation'))
  expect(calls).toContain('stopSimulatedRoute')
  expect(calls).toContain('stopLocation')
  expect(calls.filter((c) => c.startsWith('BROWSER'))).toEqual([])
  // The route request for the new route was a real one, through the plugin.
  expect(calls.filter((c) => c === 'httpGet').length).toBeGreaterThanOrEqual(2)

  // A test drive is made up: it is not kept in the private drive log (#107).
  expect(await page.evaluate(() => localStorage.getItem('routeiq.drives.v1'))).toBeNull()

  // The app is closed and opened again: the drive's diagnostics are still there, as "Last drive", and can be shared.
  await page.getByRole('button', { name: 'Done' }).click()
  await page.clock.fastForward(5000)
  await page.reload()
  await app.routesReady()
  await page.getByRole('button', { name: 'Drive diagnostics' }).click()
  await expect(page.getByRole('button', { name: /^Last drive \(saved / })).toHaveAttribute('aria-pressed', 'true')
  const last = await page.getByLabel('Diagnostics text').inputValue()
  await app.snap('after closing and opening the app: the last drive')
  expect(last).toContain('SIMULATED GPS test drive: wrong-turn, 3x speed')
  expect(last).toContain('SIMULATED GPS: 1 test drive')
  expect(last).toMatch(/fixes: [1-9]\d+ \([1-9]\d* while not active\)/)
  expect(last).toMatch(/requests: [1-9]\d* sent/)
  expect(last).toContain('gps off')
  expect(last).not.toMatch(/\d\.\d|pk\.|https?:/)
  // What is kept on the phone is that text and nothing about where anything was.
  const stored = await page.evaluate(() => localStorage.getItem('routeiq.shell.lastDrive.v1') ?? '')
  expect(stored).toContain('SIMULATED GPS')
  expect(stored).not.toMatch(/\d\.\d|pk\.|https?:/)

  await page.getByRole('button', { name: 'Share' }).click()
  expect(await page.evaluate(() => (window as unknown as ShellWindow).__shell.shared)).toEqual([last])
  // This launch's own log is one tap away, and has no drive in it yet.
  await page.getByRole('button', { name: 'Since the app opened' }).click()
  await expect(page.getByLabel('Diagnostics text')).toHaveValue(/fixes: 0 /)
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
