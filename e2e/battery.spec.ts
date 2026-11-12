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

  // The drive itself is the same: every line said, in the same order and within the same 2 s
  // step of the drive. (Not to the millisecond: where the drive starts within a step depends
  // on the real time lost at Start, the #71 race the harness keeps on purpose, so a check due
  // at 179.4 s is answered in the step of 178 s on one run and of 180 s on another.)
  expect(lockedSaid.map((l) => l.text)).toEqual(seenSaid.map((l) => l.text))
  lockedSaid.forEach((l, i) => expect(Math.abs(l.atMs - seenSaid[i]!.atMs), l.text).toBeLessThanOrEqual(2000))
  expect(lockedSaid.filter((l) => l.text.startsWith('Switching to a faster route.'))).toHaveLength(1)
  expect(lockedSaid.at(-1)!.text).toMatch(/^You have arrived\./)
  // ... the same requests, answered with the same routes in the same order (their times differ
  // by where the car was within that step: 50 m of the jammed road is 11 s), and the same
  // probes finding the same roads, ...
  expect(app.directionsRequests).toBe(seen.directionsRequests)
  expect(app.answers.map((a) => [a.n, a.routes.map((r) => r.name)])).toEqual(seen.answers.map((a) => [a.n, a.routes.map((r) => r.name)]))
  const probed = (x: App) => x.probes.map((p) => [p.forRequest, p.duringDrive, p.road])
  expect(probed(app)).toEqual(probed(seen))
  // ... the same switch at the same moment (seen as a banner, heard with the phone locked) ...
  expect(seenLog.banners).toHaveLength(1)
  expect(Math.abs(seenLog.banners[0]!.atSec - log.heard[0]!.atSec)).toBeLessThanOrEqual(2)
  expect(log.banners).toEqual([])
  // ... and the same arrival, which the screen shows as soon as it is unlocked.
  expect(log.arrived).toBe(true)
  expect(Math.abs(log.seconds - seenLog.seconds)).toBeLessThanOrEqual(2)
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

/** The drive view's arrival time ("8:21 AM"), in minutes of the day. */
async function arrivalMinutes(app: App): Promise<number> {
  const text = (await app.page.locator('.live-eta-clock').innerText()).trim()
  const m = /^(\d{1,2}):(\d{2})\s*([AP]M)?$/i.exec(text)
  expect(m, `an arrival time, not "${text}"`).not.toBeNull()
  const h = Number(m![1])
  const hour = m![3] === undefined ? h : (h % 12) + (m![3].toUpperCase() === 'PM' ? 12 : 0)
  return hour * 60 + Number(m![2])
}

test('when I unlock the phone just after a switch it made while locked, the screen shows the switch at once, as if it had been on', async ({ app, browser }, info) => {
  // The screen on all the way: the arrival time the drive view showed with the switch banner.
  const context = await browser.newContext()
  const seen = new App(await context.newPage(), info)
  seen.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
  await seen.open({ fakeClock: true, shell: true, path: SHELL, storage: TOKEN })
  await seen.routesReady()
  const arrivals = new Map<number, number>()
  const looks = Array.from({ length: 200 }, (_, i) => ({ atSec: 2 * i, look: async () => void arrivals.set(2 * i, await arrivalMinutes(seen)) }))
  const seenLog = await seen.drive({ lookAtSec: looks, maxSec: 400 })
  expect(seen.unexpected).toEqual([])
  expect(seenLog.banners).toHaveLength(1)
  const seenArrival = arrivals.get(seenLog.banners[0]!.atSec)!
  await context.close()

  // Locked at 30 s; the switch is heard; the phone is unlocked the next moment, before any other fix or tick.
  app.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
  await app.open({ fakeClock: true, shell: true, path: SHELL, storage: TOKEN })
  await app.routesReady()
  let banner = ''
  let arrival = 0
  const log = await app.drive({
    hideAtSec: 30,
    showAfterHeard: true,
    maxSec: 400,
    onShow: async () => {
      await expect(app.page.locator('.live-banner')).toBeVisible()
      banner = await app.page.locator('.live-banner').innerText()
      arrival = await arrivalMinutes(app)
      await expect(app.page.getByRole('button', { name: /Keep previous/ })).toBeVisible()
      await app.snap('unlocked just after a switch made while locked: the banner and Keep previous route')
    },
  })
  expect(log.heard).toHaveLength(1)
  // The banner of the switch that was spoken: the same saving.
  const saving = /Saves (\d+) minutes?/.exec(log.heard[0]!.text)![1]
  expect(banner).toContain('Switched to a faster route')
  expect(banner).toContain(`saves ${saving} minute`)
  // The arrival time is today's, worked out from the clock now, not from when the screen went
  // dark: the same minute as with the screen on (give or take the minute it can fall across).
  // From the clock of the lock, two and a half minutes before, it would be 2 or 3 minutes early.
  expect(Math.abs(arrival - seenArrival)).toBeLessThanOrEqual(1)
})
