import type { Locator, Page } from '@playwright/test'
import { expect, test } from './harness.ts'
import { JAM_ON_A_FROM_SECOND_CHECK } from './world/traffic.ts'

// A phone in a landscape dash mount (#131): the driving screen keeps the map and
// the car in view, and nothing a driver reads or taps is covered or off the screen,
// including the switch and Keep my route.

test.use({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true })

/** Whether the element is drawn on top at its own centre (nothing covers it) and lies inside the screen. */
async function inViewAndOnTop(page: Page, target: Locator): Promise<string> {
  const box = await target.boundingBox()
  if (box === null) return 'not drawn'
  const { width, height } = page.viewportSize()!
  if (box.x < 0 || box.y < 0 || box.x + box.width > width + 0.5 || box.y + box.height > height + 0.5) return `off the screen: ${JSON.stringify(box)}`
  const onTop = await target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return hit !== null && (el === hit || el.contains(hit))
  })
  return onTop ? 'ok' : 'covered'
}

/** Whether the car, drawn at the middle of the map (the camera follows it), is in view: nothing of the app's own covers that point. */
async function carVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const map = document.querySelector('.map')!.getBoundingClientRect()
    const hit = document.elementFromPoint(map.left + map.width / 2, map.top + map.height / 2)
    return hit !== null && hit.closest('.map') !== null
  })
}

test('in landscape the map and the car stay in view beside the turn card and the sheet, and More never pushes End off the screen', async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  const looked: string[] = []
  await app.drive({
    maxSec: 64,
    lookAtSec: [
      {
        atSec: 60,
        look: async () => {
          await page.clock.runFor(50)
          await app.snap('landscape: driving')
          expect(await carVisible(page)).toBe(true)
          // Beside, not under: none of the map is hidden behind the turn card or the sheet.
          const [map, card, sheet] = await Promise.all(['.map', '.live-top', '.live-bottom'].map(async (s) => (await page.locator(s).boundingBox())!))
          expect(map.x).toBeGreaterThanOrEqual(Math.max(card!.x + card!.width, sheet!.x + sheet!.width) - 1)
          expect(await inViewAndOnTop(page, page.getByLabel('Next turn'))).toBe('ok')
          expect(await inViewAndOnTop(page, page.locator('.live-eta'))).toBe('ok')
          for (const name of ['More', 'End']) expect(await inViewAndOnTop(page, page.getByRole('button', { name })), name).toBe('ok')
          await page.getByRole('button', { name: 'More' }).click()
          await page.locator('.live-more').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
          await app.snap('landscape: More open')
          for (const name of ['Less', 'End']) expect(await inViewAndOnTop(page, page.getByRole('button', { name })), `${name} with More open`).toBe('ok')
          expect(await carVisible(page)).toBe(true)
          await page.getByRole('button', { name: 'Less' }).click()
          looked.push('driving')
        },
      },
    ],
  })
  expect(looked).toEqual(['driving'])
})

test('in landscape the switch, its reason and Keep my route are on the screen and not covered', async ({ app, page }) => {
  app.outside.traffic = JAM_ON_A_FROM_SECOND_CHECK
  await app.open({ fakeClock: true })
  await app.routesReady()
  let checked = false
  const looks = Array.from({ length: 200 }, (_, i) => ({
    atSec: i * 2,
    look: async () => {
      if (checked || (await page.locator('.live-banner').count()) === 0) return
      checked = true
      await page.clock.runFor(50)
      await app.snap('landscape: the switch')
      const keep = page.getByRole('button', { name: /^Keep (my|previous) route$/ })
      expect(await inViewAndOnTop(page, keep)).toBe('ok')
      expect(await inViewAndOnTop(page, page.locator('.live-banner strong').first())).toBe('ok')
      expect(await inViewAndOnTop(page, page.getByRole('button', { name: 'End' }))).toBe('ok')
      expect(await carVisible(page)).toBe(true)
    },
  }))
  await app.drive({ maxSec: 400, lookAtSec: looks })
  expect(checked).toBe(true)
})
