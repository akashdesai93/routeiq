// Design guards: measurements of what a driver sees, for e2e/design.spec.ts and
// any scenario that wants them. Each returns the offending elements in words,
// so a failure says what broke ("12px span.live-tile-label "Distance""), and an
// empty list when the screen is fine. The rules are the ux-review and
// design-tokens skills (.claude/skills).
//
// Map internals (Mapbox's canvas, markers and its attribution, which it draws
// and sizes itself) are left out of every measure: they are not RouteIQ's UI.

import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'

/** Mapbox's own parts of the page. */
const MAP_INTERNALS = '.mapboxgl-canvas-container, .mapboxgl-control-container, .mapboxgl-marker'

/**
 * Accessibility problems axe rates serious or critical, as "rule (count): where".
 * Works on the fake clock too: a drive pauses it, and axe waits on timers, so
 * time is let through a millisecond at a time while it runs (the app's own
 * timers, a second apart, do not fire meanwhile).
 */
export async function axeProblems(page: Page): Promise<string[]> {
  let done = false
  const run = new AxeBuilder({ page })
    .exclude('.mapboxgl-canvas-container')
    .exclude('.mapboxgl-control-container')
    .exclude('.mapboxgl-marker')
    .analyze()
    .finally(() => {
      done = true
    })
  for (let i = 0; i < 20_000 && !done; i++) await page.clock.runFor(1).catch(() => {})
  const result = await run
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)
}

/** Everything that can be tapped inside `scope` and is smaller than `minPx` either way. */
export async function smallTargets(scope: Locator, minPx: number): Promise<string[]> {
  return scope.evaluate(
    (root, [min, internals]) => {
      const out: string[] = []
      for (const el of root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [role="button"], [role="switch"], [role="option"]')) {
        if (el.closest(internals) !== null) continue
        const r = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        if (r.width === 0 || r.height === 0 || style.visibility === 'hidden') continue
        if (r.height < min || r.width < min) {
          out.push(`${Math.round(r.width)}x${Math.round(r.height)} ${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30) || el.getAttribute('aria-label')}"`)
        }
      }
      return out
    },
    [minPx, MAP_INTERNALS] as const,
  )
}

/** Visible text inside `scope` set smaller than `minPx`. Screen-reader-only text is not drawn and does not count. */
export async function smallText(scope: Locator, minPx: number): Promise<string[]> {
  return scope.evaluate(
    (root, [min, internals]) => {
      const out: string[] = []
      for (const el of [root, ...root.querySelectorAll('*')]) {
        if (el.closest(internals) !== null || el.closest('.visually-hidden') !== null) continue
        const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '')
        if (!hasText) continue
        const r = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        if (r.width === 0 || r.height === 0 || style.visibility === 'hidden') continue
        const size = Number.parseFloat(style.fontSize)
        if (size < min) out.push(`${size}px ${el.tagName.toLowerCase()}.${(el as HTMLElement).className} "${(el.textContent ?? '').trim().slice(0, 30)}"`)
      }
      return out
    },
    [minPx, MAP_INTERNALS] as const,
  )
}

/**
 * What reaches past the left or right edge of the screen, by how many pixels:
 * a page that slides sideways, or text cut off by a clipping column. Empty
 * when everything fits the width.
 */
export async function offscreenX(page: Page): Promise<string[]> {
  return page.evaluate((internals) => {
    const width = document.documentElement.clientWidth
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest(internals) !== null || el.closest('.visually-hidden') !== null) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue
      const past = Math.max(r.right - width, -r.left)
      if (past > 0.5) out.push(`${Math.round(past)}px ${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 30)}"`)
    }
    // The page itself scrolling sideways, even with nothing measurable past the edge.
    if (document.documentElement.scrollWidth > width) out.push(`page scrolls ${document.documentElement.scrollWidth - width}px sideways`)
    return out
  }, MAP_INTERNALS)
}

/**
 * Elements inside `scope` drawn in amber (text, fill or border), outside `news`:
 * amber means a faster route and nothing else (design-tokens, rule 1). Amber is
 * any strong orange-yellow, so a near-copy of the token is caught too.
 */
export async function amberOutside(scope: Locator, news: string): Promise<string[]> {
  return scope.evaluate(
    (root, [newsSelector, internals]) => {
      const amber = (css: string): boolean => {
        const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(css)
        if (m === null || (m[4] !== undefined && Number(m[4]) < 0.2)) return false
        const [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        if (max - min < 0.35 || max !== r) return false
        const hue = (60 * (g - b)) / (max - min)
        return hue >= 30 && hue <= 55
      }
      const out: string[] = []
      for (const el of [root, ...root.querySelectorAll('*')]) {
        if (el.closest(internals) !== null || el.closest(newsSelector) !== null) continue
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        const s = getComputedStyle(el)
        const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '')
        const borders = Number.parseFloat(s.borderTopWidth) > 0 ? [s.borderTopColor] : []
        const used = [s.backgroundColor, ...borders, ...(hasText ? [s.color] : [])]
        if (used.some(amber)) out.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className} "${(el.textContent ?? '').trim().slice(0, 30)}"`)
      }
      return out
    },
    [news, MAP_INTERNALS] as const,
  )
}
