import { expect, test, type App } from './harness.ts'
import { JAM_ON_A_FROM_SECOND_CHECK, JAM_ONLY_THE_EAST_LOOP_MISSES } from './world/traffic.ts'

// The switch moment on the driving screen (#84; design #22, #43, #44): a
// faster route is first checked (pending: an amber outline, what it would
// save), then taken (confirmed: filled amber, the spoken line word for word,
// the old and new times side by side), and "Keep my route" turns it down at
// either stage (kept: a calm banner). Live drives on the fake clock and GPS,
// on a phone.
//
// The jam on the direct route starts at the second check; the engine sees a
// loop round it win that check (pending) and the next (confirmed).

const KEEPING = 'Keeping the previous route.'

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

/** "Saves 8.3 minutes. Turn in 0.8 miles." → { saveMin: 8.3, turn: '0.8 mi' } */
function said(line: string): { saveMin: number; turn: string } {
  const m = /Saves ([\d.]+) minutes\. Turn in ([\d.]+) miles\.$/.exec(line)
  expect(m, `a switch line with a saving and a turn: ${line}`).not.toBeNull()
  return { saveMin: Number(m![1]), turn: `${m![2]} mi` }
}

/** "10:24 AM" → minutes since midnight. */
function clockMin(text: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(text.trim())
  expect(m, `a clock time: ${text}`).not.toBeNull()
  return (Number(m![1]) % 12) * 60 + Number(m![2])
}

async function startJammedDrive(app: App, traffic = JAM_ON_A_FROM_SECOND_CHECK) {
  app.outside.traffic = traffic
  await app.open({ fakeClock: true })
  await app.routesReady()
}

test('when a faster route turns up, it first says it is checking and what it would save, then switches and shows the old and new times', async ({ app, page }) => {
  await startJammedDrive(app)
  const sheet = page.getByLabel('Live drive')
  const keep = page.getByRole('button', { name: 'Keep my route' })
  const news = sheet.locator('.live-news')

  const log = await app.drive({
    onMoment: async ({ stage }) => {
      if (stage === 'pending') {
        await expect(news).toHaveAttribute('data-stage', 'pending')
        await expect(news.locator('strong')).toHaveText('Checking a faster route')
        // What it would save, and what it does to the lights (never a count when one is not full).
        await expect(news.locator('.live-news-detail')).toHaveText(/^Would save \d+ min · (\d+ (fewer|more) lights?|same lights|lights: can't compare)$/)
        // Nothing has changed yet: the time line is the usual one, and nothing was said.
        await expect(sheet.locator('.live-eta')).toHaveText(/^\d+ minArrive \d{1,2}:\d{2} AM$/)
        expect((await app.spoken()).filter((l) => l.startsWith('Switching'))).toEqual([])
        // The way out is offered already, as a large target.
        const box = await keep.boundingBox()
        expect(box!.height).toBeGreaterThanOrEqual(44)
        await app.snap('pending: checking a faster route, Keep my route offered')
      }
      if (stage === 'confirmed') {
        const line = (await app.spoken()).filter((l) => l.startsWith('Switching')).at(-1)!
        const { saveMin, turn } = said(line)
        // The banner is the spoken line, word for word.
        await expect(news.locator('strong')).toHaveText(line)
        // The turn card never shows the turn-off's figure on another turn: here the next turn is a
        // stretch both routes share (Cross Street), before the turn-off, so it keeps its own, nearer
        // distance. (On the turn-off itself the card holds the spoken figure: tests/live.test.ts.)
        const card = page.getByLabel('Next turn').locator('.live-turn-distance')
        const cardText = (await card.textContent())!
        if (cardText !== turn) expect(Number.parseFloat(cardText)).toBeLessThan(Number.parseFloat(turn))
        // The old time and arrival, struck through, beside the new ones: they differ by what was said.
        const eta = sheet.locator('.live-eta-switch')
        const [oldMin, newText] = [await eta.locator('.live-eta-change .live-eta-old').textContent(), await eta.locator('.live-eta-new').textContent()]
        const newMin = Number(/^(\d+) min$/.exec(newText!)![1])
        // Each figure is rounded to the minute: they agree with the spoken saving within one.
        expect(Math.abs(Number(oldMin) - newMin - saveMin)).toBeLessThanOrEqual(1)
        const oldArrive = clockMin((await eta.locator('.live-eta-clock .live-eta-old').textContent())!)
        const newArrive = clockMin((await eta.locator('.live-eta-now').textContent())!)
        expect(Math.abs(oldArrive - newArrive - saveMin)).toBeLessThanOrEqual(1)
        await expect(keep).toBeVisible()
        await app.snap(`confirmed: ${line}`)
      }
    },
  })

  expect(log.arrived).toBe(true)
  // Checked first, then taken: two stages, in that order, and one switch.
  expect(log.moments.map((m) => m.stage)).toEqual(['pending', 'confirmed'])
  expect(log.banners).toHaveLength(1)
  expect(log.moments[1]!.atSec).toBeGreaterThan(log.moments[0]!.atSec)
})

test('Keep my route after the switch puts me back on my route, says so calmly, and that route is not taken again', async ({ app, page }) => {
  // Only the East Loop misses this jam: once it is turned down there is nothing else to switch to.
  await startJammedDrive(app, JAM_ONLY_THE_EAST_LOOP_MISSES)
  const sheet = page.getByLabel('Live drive')
  const news = sheet.locator('.live-news')

  const log = await app.drive({
    keepMyRoute: 'confirmed',
    onMoment: async ({ stage }) => {
      if (stage !== 'kept') return
      await expect(news.locator('strong')).toHaveText(KEEPING)
      await expect(news.locator('.live-news-detail')).toHaveText("Won't offer that route again for 10 min.")
      // Calm: not amber news, nothing to undo, and the usual time line again.
      await expect(news).toHaveAttribute('data-stage', 'kept')
      await expect(page.getByRole('button', { name: 'Keep my route' })).toHaveCount(0)
      await expect(sheet.locator('.live-eta')).toHaveText(/^\d+ minArrive \d{1,2}:\d{2} AM$/)
      await app.snap('kept: staying on my route')
    },
  })
  await app.snap('arrived: the switch was turned down')

  expect(log.arrived).toBe(true)
  const spoken = await app.spoken()
  expect(spoken.filter((l) => l.startsWith('Switching'))).toHaveLength(1)
  expect(spoken).toContain(KEEPING)
  expect(log.moments.map((m) => m.stage)).toEqual(expect.arrayContaining(['confirmed', 'kept']))
  // No other switch: the East Loop was not taken again, and the summary says the driver kept their route.
  expect(log.banners).toHaveLength(1)
  await expect(page.getByLabel('Drive summary')).toContainText('RouteIQ stayed on the first route')
  await expect(page.getByLabel('Drive summary')).toContainText('You kept the previous route once.')
})

test('Keep my route while it is still checking: nothing switches', async ({ app, page }) => {
  await startJammedDrive(app, JAM_ONLY_THE_EAST_LOOP_MISSES)
  const log = await app.drive({
    keepMyRoute: 'pending',
    onMoment: async ({ stage }) => {
      if (stage === 'kept') await app.snap('kept while pending: nothing was switched')
    },
  })

  expect(log.arrived).toBe(true)
  expect(log.moments.slice(0, 2).map((m) => m.stage)).toEqual(['pending', 'kept'])
  expect(log.banners).toEqual([])
  const spoken = await app.spoken()
  expect(spoken.filter((l) => l.startsWith('Switching'))).toEqual([])
  expect(spoken).toContain(KEEPING)
  await expect(page.getByLabel('Drive summary')).toContainText('You kept the previous route once.')
})

test('ten minutes after I kept my route, a route that is still faster is offered again, as a new check', async ({ app, page }) => {
  await startJammedDrive(app, JAM_ONLY_THE_EAST_LOOP_MISSES)
  const news = page.getByLabel('Live drive').locator('.live-news')
  const seen: { atSec: number; stage: string; title: string }[] = []
  // Slowly (8 m/s), so the East Loop still turns off ahead of the car ten minutes on.
  const log = await app.drive({
    speedMps: 8,
    maxSec: 1200,
    keepMyRoute: 'pending',
    onMoment: async ({ atSec, stage }) => {
      const title = (await news.locator('strong').textContent()) ?? ''
      const keptBefore = seen.some((m) => m.stage === 'kept')
      seen.push({ atSec, stage, title })
      if (stage === 'pending' && keptBefore) {
        await expect(page.getByRole('button', { name: 'Keep my route' })).toBeVisible()
        await app.snap('offered again after ten minutes: still faster, checking again')
      }
    },
  })

  const first = seen.find((m) => m.stage === 'pending')!
  const kept = seen.find((m) => m.stage === 'kept')!
  const again = seen.find((m) => m.stage === 'pending' && m.atSec > kept.atSec)
  expect(first.title).toBe('Checking a faster route')
  expect(again, 'offered again').toBeDefined()
  expect(again!.title).toBe('Still faster. Checking again.')
  // Not before the ten minutes the kept banner promised, counted from the tap (on the first offer).
  expect(again!.atSec - first.atSec).toBeGreaterThanOrEqual(600)
  // Nothing was switched in between.
  expect(log.banners.filter((b) => b.atSec < again!.atSec)).toEqual([])
})
