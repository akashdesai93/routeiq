import { amberOutside, axeProblems, offscreenX, smallTargets, smallText } from './design.ts'
import { expect, test } from './harness.ts'

// Design guards: the screens a driver sees, at iPhone sizes, held to the rules
// of the ux-review and design-tokens skills (.claude/skills) and the UX audit
// (docs/design/ux-audit.md). Each check fails when the screen regresses in a
// way a driver would feel: a tap that misses, text too small to read at arm's
// length, a page that slides sideways, amber that cries wolf, or a control a
// screen reader or Voice Control can't reach.

for (const { width, height } of [
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]) {
  test.describe(`on a ${width}x${height} phone`, () => {
    test.use({ viewport: { width, height }, isMobile: true, hasTouch: true })

    test('the trip screen can be read and tapped: nothing under 44 px or 13 px, nothing sideways, no serious accessibility problem', async ({ app, page }) => {
      await app.open()
      await app.routesReady()
      const screen = page.locator('.app')
      expect(await smallTargets(screen, 44), 'controls under 44 px').toEqual([])
      expect(await smallText(screen, 13), 'text under 13 px').toEqual([])
      expect(await offscreenX(page), 'past the edge of the screen').toEqual([])
      expect(await axeProblems(page), 'serious accessibility problems').toEqual([])
    })

    test('the driving screen reads at a glance: 60 px controls, nothing under 14 px, amber only for news, nothing sideways, accessible with More shut and open', async ({ app, page }) => {
      await app.open({ fakeClock: true })
      await app.routesReady()
      const drive = page.locator('.live-top, .live-bottom')
      const checks: string[] = []
      await app.drive({
        maxSec: 64,
        lookAtSec: [
          {
            atSec: 60,
            look: async () => {
              await app.snap('the driving screen under the design guards')
              // The two drive controls are big enough to hit without looking twice.
              for (const name of ['More', 'End']) {
                const box = (await page.getByRole('button', { name }).boundingBox())!
                expect(box.height, `${name} height`).toBeGreaterThanOrEqual(60)
              }
              for (const part of await drive.all()) {
                expect(await smallTargets(part, 44), 'controls under 44 px').toEqual([])
                expect(await smallText(part, 14), 'text under 14 px while driving').toEqual([])
                expect(await amberOutside(part, '.live-banner'), 'amber with no switch on').toEqual([])
              }
              expect(await offscreenX(page), 'past the edge of the screen').toEqual([])
              expect(await axeProblems(page), 'serious accessibility problems, More shut').toEqual([])

              await page.getByRole('button', { name: 'More' }).click()
              // The sheet rises in 280 ms of real time (CSS animations don't follow the fake
              // clock); measure it where it comes to rest, or axe sees it half transparent.
              await page.locator('.live-more').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
              const sheet = page.locator('.live-bottom')
              expect(await smallTargets(sheet, 44), 'controls under 44 px in More').toEqual([])
              expect(await smallText(sheet, 14), 'text under 14 px in More').toEqual([])
              expect(await amberOutside(sheet, '.live-banner'), 'amber in More').toEqual([])
              expect(await offscreenX(page), 'past the edge of the screen, More open').toEqual([])
              expect(await axeProblems(page), 'serious accessibility problems, More open').toEqual([])
              await app.snap('More, under the design guards')
              await page.getByRole('button', { name: 'Less' }).click()
              checks.push('looked')
            },
          },
        ],
      })
      expect(checks).toEqual(['looked'])
    })
  })
}

test.describe('on a phone in landscape', () => {
  test.use({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true })

  test('nothing on the trip screen or the driving screen reaches past the edge', async ({ app, page }) => {
    await app.open({ fakeClock: true })
    await app.routesReady()
    expect(await offscreenX(page), 'trip screen').toEqual([])
    let looked = false
    await app.drive({
      maxSec: 64,
      lookAtSec: [
        {
          atSec: 60,
          look: async () => {
            expect(await offscreenX(page), 'driving screen').toEqual([])
            looked = true
          },
        },
      ],
    })
    expect(looked).toBe(true)
  })
})
