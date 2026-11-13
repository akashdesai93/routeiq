import { amberOutside, axeProblems, crampedTargets, mapShare, offscreenX, smallTargets, smallText } from './design.ts'
import { expect, test } from './harness.ts'

// Design guards: the screens a driver sees, at iPhone sizes, held to the rules
// of the ux-review and design-tokens skills (.claude/skills) and the UX audit
// (docs/design/ux-audit.md). Each check fails when the screen regresses in a
// way a driver would feel: a tap that misses, text too small to read at arm's
// length, a page that slides sideways, amber that cries wolf, or a control a
// screen reader or Voice Control can't reach.

/**
 * The least share of the screen the map must keep (#197, "the map is too small"), measured
 * with mapShare: the trip screen with its routes, and the driving screen a minute into a
 * drive (with this browser's one-line wake-lock warning, which the iPhone shell never shows).
 * On main before #197: trip 40 / 39 / 48 %, driving 56 / 62 / 55 % (390, 430, landscape).
 * After: trip 48 / 48 / 53 %, driving 59 / 62 / 60 %.
 */
const MIN_MAP_SHARE = {
  '390x844': { trip: 0.46, driving: 0.575 },
  '430x932': { trip: 0.46, driving: 0.61 },
  '844x390': { trip: 0.51, driving: 0.59 },
} as const

/** The least gap between two things a finger taps, edge to edge (#197, "things are too close together"). */
const MIN_TAP_GAP_PX = 8

for (const { width, height, min } of [
  { width: 390, height: 844, min: MIN_MAP_SHARE['390x844'] },
  { width: 430, height: 932, min: MIN_MAP_SHARE['430x932'] },
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
      for (const part of await page.locator('.plan, .panel').all()) {
        expect(await crampedTargets(part, MIN_TAP_GAP_PX), 'controls closer than 8 px').toEqual([])
      }
      const share = await mapShare(page)
      expect(share, 'the map\'s share of the trip screen').toBeGreaterThanOrEqual(min.trip)
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
              expect(await mapShare(page), 'the map\'s share of the driving screen').toBeGreaterThanOrEqual(min.driving)
              for (const part of await drive.all()) {
                expect(await crampedTargets(part, MIN_TAP_GAP_PX), 'controls closer than 8 px').toEqual([])
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
    // An 844 px wide phone is still a phone in a hand (#132): every control is a finger's size,
    // although the screen is wide enough for the side-by-side layout.
    await app.snap('the trip screen in landscape: every control 44 px or more')
    expect(await smallTargets(page.locator('.app'), 44), 'trip screen controls under 44 px').toEqual([])
    expect(await mapShare(page), 'the map\'s share of the trip screen').toBeGreaterThanOrEqual(MIN_MAP_SHARE['844x390'].trip)
    let looked = false
    await app.drive({
      maxSec: 64,
      lookAtSec: [
        {
          atSec: 60,
          look: async () => {
            expect(await offscreenX(page), 'driving screen').toEqual([])
            expect(await mapShare(page), 'the map\'s share of the driving screen').toBeGreaterThanOrEqual(MIN_MAP_SHARE['844x390'].driving)
            expect(await crampedTargets(page.locator('.live-bottom'), MIN_TAP_GAP_PX), 'controls closer than 8 px').toEqual([])
            looked = true
          },
        },
      ],
    })
    expect(looked).toBe(true)
  })
})

// The two guards above are only worth something if they can fail: each run plants the regression
// it is there to catch and checks that it is caught.
test.describe('the guards catch what they guard', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('a turn card grown tall, or the drive controls pushed together, is caught', async ({ app, page }) => {
    await app.open({ fakeClock: true })
    await app.routesReady()
    let looked = false
    await app.drive({
      maxSec: 64,
      lookAtSec: [
        {
          atSec: 60,
          look: async () => {
            expect(await mapShare(page)).toBeGreaterThanOrEqual(MIN_MAP_SHARE['390x844'].driving)
            expect(await crampedTargets(page.locator('.live-bottom'), MIN_TAP_GAP_PX)).toEqual([])
            // The turn card at 124 px with its old padding, the sheet with its old 27 px top:
            // a little less map is enough to fail.
            const tall = await page.addStyleTag({ content: '.live-top { min-height: 160px !important; } .live-bottom { padding-top: 40px !important; }' })
            expect(await mapShare(page)).toBeLessThan(MIN_MAP_SHARE['390x844'].driving)
            await tall.evaluate((el) => (el as HTMLElement).remove())
            // More and End 4 px apart.
            await page.addStyleTag({ content: '.live-controls { gap: 4px !important; }' })
            expect(await crampedTargets(page.locator('.live-bottom'), MIN_TAP_GAP_PX)).toEqual([expect.stringMatching(/More.*End.*: 4 px$/)])
            looked = true
          },
        },
      ],
    })
    expect(looked).toBe(true)
  })
})
