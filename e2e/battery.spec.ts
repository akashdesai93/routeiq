import type { E2EWindow } from './browserStubs.ts'
import { App, expect, test } from './harness.ts'
import { NO_TOKEN_PORT } from './ports.ts'
import { JAM_ON_A_FROM_SECOND_CHECK } from './world/traffic.ts'

// Battery (#98): while nobody can see the screen, the app draws nothing, and the drive
// itself is not changed in any way. Two drives of the same trip in the iPhone shell, with the
// same traffic: one with the screen on all the way, one with the phone locked half a minute
// in. What the page does while locked is counted: React commits and WebGL draw calls (the
// map drawing a frame).

const SHELL = `http://localhost:${NO_TOKEN_PORT}/`
const TOKEN = { 'routeiq.shell.mapboxToken': 'pk.test' }

type Said = { atMs: number; text: string }

async function said(app: App): Promise<Said[]> {
  const lines = await app.page.evaluate(() => (window as unknown as E2EWindow).__e2e.spoken)
  const t0 = lines[0]?.atMs ?? 0
  return lines.map((l) => ({ atMs: l.atMs - t0, text: l.text }))
}

test('with the phone locked nothing is drawn, and the drive says and does exactly what it does with the screen on', async ({ app, browser }, info) => {
  // The screen on all the way: a second page of its own, same trip, same traffic.
  const context = await browser.newContext()
  const seen = new App(await context.newPage(), info)
  seen.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
  await seen.open({ fakeClock: true, shell: true, path: SHELL, storage: TOKEN })
  await seen.routesReady()
  const seenLog = await seen.drive()
  const seenSaid = await said(seen)
  expect(seenLog.arrived).toBe(true)
  expect(seen.unexpected).toEqual([])

  // Locked 30 s in, until the driver picks the phone up on arrival.
  app.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
  await app.open({ fakeClock: true, shell: true, path: SHELL, storage: TOKEN })
  await app.routesReady()
  const before = await app.page.evaluate(() => ({ ...(window as unknown as E2EWindow).__e2e.work }))
  const log = await app.drive({ hideAtSec: 30 })
  const after = await app.page.evaluate(() => ({ ...(window as unknown as E2EWindow).__e2e.work }))
  await app.snap('the phone unlocked on arrival: the summary, drawn in one go')
  const lockedSaid = await said(app)

  // While locked: hundreds of fixes came in, and not one React commit or map frame came of them.
  // The only commits are the private drive log's two writes (#107): one at the switch, one at
  // the arrival, each kept on the phone at once in case the app is closed.
  expect(log.hiddenWork.fixes).toBeGreaterThan(200)
  expect(log.heard).toHaveLength(1)
  expect(log.hiddenWork.commits).toBe(2)
  expect(log.hiddenWork.draws).toBe(0)
  // The page was not idle the rest of the time: the same counters do move while it is seen.
  expect(after.commits - before.commits - log.hiddenWork.commits).toBeGreaterThan(5)
  expect(after.draws - before.draws - log.hiddenWork.draws).toBeGreaterThan(5)

  // The drive itself is the same: every line said, at the same second of the drive, ...
  expect(lockedSaid).toEqual(seenSaid)
  expect(lockedSaid.filter((l) => l.text.startsWith('Switching to a faster route.'))).toHaveLength(1)
  expect(lockedSaid.at(-1)!.text).toMatch(/^You have arrived\./)
  // ... the same requests, answered the same way, ...
  expect(app.directionsRequests).toBe(seen.directionsRequests)
  expect(app.answers).toEqual(seen.answers)
  expect(app.probes).toEqual(seen.probes)
  // ... the same switch at the same moment (seen as a banner, heard with the phone locked) ...
  expect(seenLog.banners.map((b) => b.atSec)).toEqual(log.heard.map((h) => h.atSec))
  expect(log.banners).toEqual([])
  // ... and the same arrival, which the screen shows as soon as it is unlocked.
  expect(log.arrived).toBe(true)
  expect(log.seconds).toBe(seenLog.seconds)
  await expect(app.page.getByLabel('Drive summary')).toBeVisible()

  await info.attach('work per drive', {
    contentType: 'text/plain',
    body: [
      `screen on: ${seenLog.seconds} s of drive`,
      `locked from 30 s: ${log.hiddenWork.fixes} fixes while locked, ${log.hiddenWork.commits} React commits and ${log.hiddenWork.draws} WebGL draw calls meanwhile`,
      `the rest of the locked drive (seen): ${after.commits - before.commits - log.hiddenWork.commits} commits, ${after.draws - before.draws - log.hiddenWork.draws} draw calls`,
    ].join('\n'),
  })
  await context.close()
})

/** What the drive view says: the next turn, the arrival time, the banner and the status line. */
async function driveText(app: App): Promise<string> {
  return app.page.evaluate(() =>
    ['[aria-label="Next turn"]', '.live-eta', '.live-banner', '.live-status']
      .map((selector) => (document.querySelector(selector) as HTMLElement | null)?.innerText ?? '')
      .join(' | '),
  )
}

test('when I unlock the phone just after a switch it made while locked, the screen shows the switch at once, as if it had been on', async ({ app, browser }, info) => {
  // The screen on all the way: what the drive view says at the end of every step.
  const context = await browser.newContext()
  const seen = new App(await context.newPage(), info)
  seen.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
  await seen.open({ fakeClock: true, shell: true, path: SHELL, storage: TOKEN })
  await seen.routesReady()
  const shown = new Map<number, string>()
  const looks = Array.from({ length: 200 }, (_, i) => ({ atSec: 2 * i, look: async () => void shown.set(2 * i, await driveText(seen)) }))
  const seenLog = await seen.drive({ lookAtSec: looks, maxSec: 400 })
  expect(seen.unexpected).toEqual([])
  expect(seenLog.banners).toHaveLength(1)
  const switchSec = seenLog.banners[0]!.atSec
  await context.close()

  // Locked at 30 s; the switch is heard; the phone is unlocked the next moment, before any other fix or tick.
  app.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
  await app.open({ fakeClock: true, shell: true, path: SHELL, storage: TOKEN })
  await app.routesReady()
  let atUnlock = ''
  const log = await app.drive({
    hideAtSec: 30,
    showAtSec: switchSec + 2,
    maxSec: switchSec + 4,
    onShow: async () => {
      await expect(app.page.locator('.live-banner')).toBeVisible()
      atUnlock = await driveText(app)
      await app.snap('unlocked just after a switch made while locked: the banner and Keep previous route')
    },
  })
  expect(log.heard.map((h) => h.atSec)).toEqual([switchSec])
  // Exactly what the screen showed with the screen on at that moment: the turn, the arrival time, the banner.
  expect(atUnlock).toBe(shown.get(switchSec))
  expect(atUnlock).toContain('Switched to a faster route')
  await expect(app.page.getByRole('button', { name: /Keep previous/ })).toBeVisible()
})
