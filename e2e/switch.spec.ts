import { expect, test, type App } from './harness.ts'
import { JAM_ON_A_FROM_SECOND_CHECK, JAM_ONLY_THE_EAST_LOOP_MISSES, JAM_ONLY_THE_EAST_LOOP_MISSES_LATE, LATE_OFFER_SPEED_MPS } from './world/traffic.ts'

// The switch moment on the driving screen (#84; design #22, #43, #44): a
// faster route is first checked (pending: an amber outline, what it would
// save), then taken (confirmed: filled amber, the spoken line word for word,
// the old and new times side by side), and "Keep my route" turns it down at
// either stage (kept: a calm banner). Live drives on the fake clock and GPS,
// on a phone.
//
// The jam on the direct route starts at the second check; the engine sees a
// loop round it win that check (pending) and the next (confirmed).

const KEEPING = 'Staying on your route.'
const OFF_ROUTE = 'You are off the route. Finding a new one.'
const SWITCH_LINE = /^Switching to a faster route\. Saves [\d.]+ minutes\. Turn in [\d.]+ (miles?|feet)\.$/

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

/** "Saves 8.3 minutes. Turn in 0.8 miles." → { saveMin: 8.3, turn: '0.8 mi' } */
function said(line: string): { saveMin: number; turn: string } {
  const m = /Saves ([\d.]+) minutes\. Turn in ([\d.]+) miles\.$/.exec(line)
  expect(m, `a switch line with a saving and a turn: ${line}`).not.toBeNull()
  return { saveMin: Number(m![1]), turn: `${m![2]} mi` }
}

/** "0.8 mi" or "450 ft" (the turn card's figure) → meters. */
function cardMeters(text: string): number {
  const m = /^([\d.]+) (mi|ft)$/.exec(text.trim())
  expect(m, `a turn-card distance: ${text}`).not.toBeNull()
  return Number(m![1]) * (m![2] === 'mi' ? 1609.344 : 0.3048)
}

/**
 * What is cut off inside `root` (a box that clips its paint): an element whose content is wider than
 * its box, or one that reaches past `root`'s edges. As "class: why".
 */
async function clipped(root: import('@playwright/test').Locator): Promise<string[]> {
  return root.evaluate((el) => {
    const outer = el.getBoundingClientRect()
    return [el, ...el.querySelectorAll('*')].flatMap((e) => {
      const r = e.getBoundingClientRect()
      const out: string[] = []
      if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0) out.push(`${e.className}: ${e.scrollWidth} wide in ${e.clientWidth}`)
      if (r.top < outer.top || r.bottom > outer.bottom || r.left < outer.left || r.right > outer.right) {
        out.push(`${e.className}: ${Math.round(r.top)}-${Math.round(r.bottom)} outside ${Math.round(outer.top)}-${Math.round(outer.bottom)}`)
      }
      return out
    })
  })
}

/** True when the middle and both ends of `part` are inside the window and nothing else is drawn over them. */
async function uncovered(part: import('@playwright/test').Locator): Promise<boolean> {
  return part.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const y = r.top + r.height / 2
    return [r.left + 4, r.left + r.width / 2, r.right - 4].every((x) => {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false
      const top = document.elementFromPoint(x, y)
      return top !== null && (el === top || el.contains(top))
    })
  })
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
        if (cardText !== turn) expect(cardMeters(cardText)).toBeLessThan(cardMeters(turn))
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
        // Nothing in the time line is cut off by its box: the amber chip keeps its round corners.
        expect(await clipped(eta)).toEqual([])
        await app.snap(`confirmed: ${line}`)
        // On the narrowest phone (375 px: iPhone mini, SE) the old and new figures still fit their boxes,
        // and the amber chip does not run into the struck arrival (#84 review).
        await page.setViewportSize({ width: 375, height: 812 })
        expect(await clipped(eta)).toEqual([])
        const chip = (await eta.locator('.live-eta-new').boundingBox())!
        const clock = (await eta.locator('.live-eta-arrive').boundingBox())!
        expect(chip.x + chip.width).toBeLessThanOrEqual(clock.x)
        await app.snap('confirmed at 375 px: old and new times fit')
        await page.setViewportSize({ width: 390, height: 844 })
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

// #197: on the evening drive a faster route was offered (the pending stage) but the
// directions stayed on the old route. Reproduced here: the East Loop wins one check with its
// turn-off about a mile ahead, and by the next check that turn-off is too close to take, so
// the checks alone never confirm it. What the driver gets at each stage: the new route's turn
// and a way to take it at once, a way to keep the old one, and a word when the offer is over.

test('when a faster route is offered, it shows its turn, and Take it switches at once and guides me onto it', async ({ app, page }) => {
  await startJammedDrive(app, JAM_ONLY_THE_EAST_LOOP_MISSES_LATE)
  const sheet = page.getByLabel('Live drive')
  const news = sheet.locator('.live-news')
  const card = page.getByLabel('Next turn')
  const take = page.getByRole('button', { name: 'Take it' })
  const keep = page.getByRole('button', { name: 'Keep my route' })

  const log = await app.drive({
    speedMps: LATE_OFFER_SPEED_MPS,
    takeIt: true,
    onMoment: async ({ stage }) => {
      if (stage === 'pending') {
        await expect(news.locator('.live-news-detail')).toHaveText(/^Would save \d+ min · /)
        // How to take it: the faster route's turn-off, with its arrow, its distance and its road,
        // while the turn card still shows the route being driven.
        await expect(sheet.getByLabel('Turn for the faster route')).toHaveText(/^[\d.]+ (mi|ft)Turn left: East Loop$/)
        await expect(card).not.toContainText('East Loop')
        // Both answers are one tap, large, and apart.
        const [t, k] = [(await take.boundingBox())!, (await keep.boundingBox())!]
        expect(t.height).toBeGreaterThanOrEqual(44)
        expect(k.height).toBeGreaterThanOrEqual(44)
        expect(k.x - (t.x + t.width)).toBeGreaterThanOrEqual(8)
        await app.snap('pending: the faster route turns left onto East Loop, Take it or Keep my route')
        // On a phone on its side the sheet is a short column: the turn and both answers are still
        // all in sight at once, none under another (the buttons are pinned over a column that scrolls).
        await page.setViewportSize({ width: 844, height: 390 })
        for (const part of [sheet.getByLabel('Turn for the faster route'), take, keep]) {
          expect(await uncovered(part), `${await part.textContent()} in sight in landscape`).toBe(true)
        }
        await app.snap('pending in landscape: the turn, Take it and Keep my route all in sight')
        await page.setViewportSize({ width: 390, height: 844 })
      }
      if (stage === 'confirmed') {
        // Guidance moved with it: the next turn is the East Loop.
        await expect(card).toContainText('East Loop')
        await expect(keep).toBeVisible()
        await app.snap('taken: switched at once, the turn card shows East Loop')
      }
    },
  })

  expect(log.arrived).toBe(true)
  const stages = log.moments.map((m) => m.stage)
  expect(stages.slice(0, 2)).toEqual(['pending', 'confirmed'])
  // At once: the switch came with the tap, not with a later check.
  expect(log.moments[1]!.atSec - log.moments[0]!.atSec).toBeLessThan(10)
  const spoken = await app.spoken()
  const switches = spoken.filter((l) => l.startsWith('Switching'))
  expect(switches).toHaveLength(1)
  expect(switches[0]).toMatch(SWITCH_LINE)
  // The turns said after it are the East Loop's, and the driver never left the route.
  expect(spoken.slice(spoken.indexOf(switches[0]!) + 1).some((l) => l.includes('East Loop'))).toBe(true)
  expect(spoken).not.toContain(OFF_ROUTE)
  await expect(page.getByLabel('Drive summary')).toContainText('RouteIQ changed route once')
})

test('when an offered route turns off too close to be confirmed, the offer ends before the turn and I stay on my route', async ({ app, page }) => {
  await startJammedDrive(app, JAM_ONLY_THE_EAST_LOOP_MISSES_LATE)
  const news = page.getByLabel('Live drive').locator('.live-news')
  const card = page.getByLabel('Next turn')

  const log = await app.drive({
    speedMps: LATE_OFFER_SPEED_MPS,
    onMoment: async ({ stage }) => {
      if (stage !== 'withdrawn') return
      // Calm, not amber news: the offer is over, and nothing is left to tap.
      await expect(news.locator('strong')).toHaveText('Too late for that turn. Staying on your route.')
      await expect(page.getByRole('button', { name: 'Take it' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Keep my route' })).toHaveCount(0)
      await expect(card).not.toContainText('East Loop')
      await app.snap('withdrawn: too late for that turn, staying on my route')
    },
  })

  expect(log.arrived).toBe(true)
  expect(log.moments.map((m) => m.stage)).toEqual(['pending', 'withdrawn'])
  // It ended while the turn-off was still ahead: before the check that finds it too late.
  const tooLate = log.statusLines.find((l) => /too late to take safely/.test(l.text))
  expect(tooLate, 'the next check finds the turn-off too close').toBeDefined()
  expect(log.moments[1]!.atSec).toBeLessThan(tooLate!.atSec)
  expect((await app.spoken()).filter((l) => l.startsWith('Switching'))).toEqual([])
})
