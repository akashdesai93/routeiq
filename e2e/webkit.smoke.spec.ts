// WebKit smoke set: the few scenarios that must hold in the engine the iPhone
// app runs on (a WKWebView), checked from the screen's pixels. Runs in the
// `webkit-iphone` project only (playwright.config.ts); the rest of the suite
// runs in Chromium. Keep it small: every scenario here costs a second browser.
//
// #136: on the phone the driving screen stayed black after Start drive while
// the DOM held the turn card and the drive ran. A DOM assertion cannot see
// that, so these look at the screenshot.

import { expect, test } from './harness.ts'
import { screenFacts, type Box } from './pixels.ts'
import type { Page } from '@playwright/test'

/** The three parts of the driving screen, read from the layout: the turn card, a band across the middle of the map, the sheet. */
async function parts(page: Page): Promise<{ card: Box; mapBand: Box; sheet: Box }> {
  const card = (await page.getByLabel('Next turn').boundingBox())!
  const sheet = (await page.getByLabel('Live drive').boundingBox())!
  const width = page.viewportSize()!.width
  // Clear of the card's shadow above and the map's attribution above the sheet.
  const top = card.y + card.height + 20
  const bottom = sheet.y - 40
  return { card, mapBand: { x: 0, y: top, width, height: bottom - top }, sheet }
}

/** How long the screen has to draw after a moment: a few frames of the fake clock. */
const DRAW_WITHIN_MS = 1000
const FRAME_STEP_MS = 100

/**
 * The driving screen as a driver sees it, within DRAW_WITHIN_MS: not one flat
 * colour, a light map in the middle with the route and the car drawn on it in
 * ink, white words on the turn card and on the sheet. The map draws on
 * animation frames, which the fake clock only gives while it runs, so the
 * screen is looked at after each step of it until it is drawn or the time is up.
 */
async function expectDrawn(page: Page, moment: string) {
  const problems: string[] = []
  let seen = ''
  for (let waitedMs = FRAME_STEP_MS; waitedMs <= DRAW_WITHIN_MS; waitedMs += FRAME_STEP_MS) {
    await page.clock.runFor(FRAME_STEP_MS)
    const { card, mapBand, sheet } = await parts(page)
    const facts = await screenFacts(page, [card, mapBand, sheet])
    const [cardFacts, mapFacts, sheetFacts] = ([0, 1, 2] as const).map((i) => ({
      meanLight: Number(facts.meanLight[i]!.toFixed(3)),
      light: Number(facts.lightShare[i]!.toFixed(4)),
      dark: Number(facts.darkShare[i]!.toFixed(4)),
    }))
    seen = JSON.stringify({ after: `${waitedMs} ms`, dominant: facts.dominant, share: Number(facts.dominantShare.toFixed(3)), card: cardFacts, map: mapFacts, sheet: sheetFacts })
    problems.length = 0
    if (facts.dominantShare >= 0.8) problems.push('the screen is one flat colour')
    if (mapFacts.meanLight <= 0.6) problems.push('the map is not drawn: the middle of the screen is dark')
    if (mapFacts.dark <= 0.002) problems.push('no route or car is drawn on the map')
    if (cardFacts.light <= 0.01) problems.push('no words on the turn card')
    if (sheetFacts.light <= 0.005) problems.push('no words on the sheet')
    if (problems.length === 0) return
  }
  expect(problems, `${moment}, not drawn within ${DRAW_WITHIN_MS} ms: ${seen}`).toEqual([])
}

/**
 * The failure on the phone (#136) that no desktop engine shows: everything composited over
 * the map (the map itself, the turn card, the sheet) went missing inside the drive view's
 * clipping, black-painted container, and only that black was on screen. During a drive no
 * element around the map may clip its contents or paint the screen dark, so even if iOS
 * fails to draw a layer, what shows is the map's light ground, never a black screen.
 */
async function expectNothingAroundTheMapClipsOrPaintsDark(page: Page) {
  const around = await page.evaluate(() => {
    const out: { element: string; overflow: string; background: string; dark: boolean }[] = []
    for (let e = document.querySelector('.map')?.parentElement ?? null; e !== null && e !== document.documentElement; e = e.parentElement) {
      const style = getComputedStyle(e)
      const [r = 0, g = 0, b = 0, a = 1] = (style.backgroundColor.match(/[\d.]+/g) ?? []).map(Number)
      const alpha = style.backgroundColor.startsWith('rgba') ? a : 1
      const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      out.push({ element: `${e.tagName.toLowerCase()}.${e.className}`, overflow: style.overflow, background: style.backgroundColor, dark: alpha > 0.1 && light < 0.5 })
    }
    return out
  })
  expect(around.length, 'the map has elements around it').toBeGreaterThan(0)
  for (const e of around) {
    expect(e.overflow, `${e.element} clips the map and the cards over it`).toBe('visible')
    expect(e.dark, `${e.element} paints the screen dark (${e.background})`).toBe(false)
  }
}

async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { value: s, configurable: true })
    Object.defineProperty(document, 'hidden', { value: s === 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

/** Takes the map's WebGL context away and never gives it back, as iOS can do to an app in the background. */
async function loseMapContext(page: Page) {
  const lost = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.mapboxgl-canvas')
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return gl?.isContextLost() ?? false
  })
  expect(lost, "the map's WebGL context was taken away").toBe(true)
}

test('the driving screen draws on an iPhone: map, turn card and sheet, from the start and after the phone comes back', async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  await app.drive({
    maxSec: 40,
    lookAtSec: [
      {
        atSec: 2,
        look: async () => {
          await expectDrawn(page, '2 s after Start drive')
          await expectNothingAroundTheMapClipsOrPaintsDark(page)
        },
      },
      {
        atSec: 10,
        look: async () => {
          await expectDrawn(page, '10 s after Start drive')
          await app.snap('WebKit, iPhone: the driving screen draws')
        },
      },
      {
        atSec: 20,
        look: async () => {
          // The phone is locked, then unlocked: the screen draws again.
          await setVisibility(page, 'hidden')
          await page.clock.runFor(5_000)
          await setVisibility(page, 'visible')
          await expectDrawn(page, 'after lock and unlock')
        },
      },
    ],
  })
})

test("when the phone takes the map's drawing context and never gives it back, the map draws again", async ({ app, page }) => {
  await app.open({ fakeClock: true })
  await app.routesReady()
  await app.drive({
    maxSec: 30,
    lookAtSec: [
      { atSec: 4, look: () => expectDrawn(page, 'before the context is lost') },
      {
        atSec: 10,
        look: async () => {
          await setVisibility(page, 'hidden')
          await loseMapContext(page)
          await page.clock.runFor(10_000)
          await setVisibility(page, 'visible')
          // The style and the layers load again: a moment, then a few frames.
          await page.clock.runFor(3_000)
          await expectDrawn(page, 'after the context was lost and not given back')
          await app.snap('WebKit, iPhone: the map drawn again after its WebGL context was lost')
        },
      },
    ],
  })
})
