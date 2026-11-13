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

/**
 * The share of the screen where the map can be seen (#197), from 0 to 1: the screen is
 * sampled on a grid, and a point counts when the topmost thing there is the map (its canvas
 * or anything Mapbox draws on it). Cards and sheets over the map, the bars around it, and
 * any black band under the page all count against it.
 */
export async function mapShare(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window.innerWidth
    const h = window.innerHeight
    const cols = 40
    const rows = 80
    let seen = 0
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const el = document.elementFromPoint(((i + 0.5) * w) / cols, ((j + 0.5) * h) / rows)
        if (el !== null && el.closest('.map') !== null) seen++
      }
    }
    return seen / (cols * rows)
  })
}

/**
 * Pairs of tappable things inside `scope` closer together than `minPx` (edge to edge), as
 * "a | b: N px" (#197): two controls that nearly touch get the wrong one tapped. A control
 * inside another (a button in a list item that is itself tappable) is not a pair.
 */
export async function crampedTargets(scope: Locator, minPx: number): Promise<string[]> {
  return scope.evaluate(
    (root, [min, internals]) => {
      const name = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 24) || el.getAttribute('aria-label')}"`
      const targets = [...root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [role="button"], [role="switch"], [role="option"]')]
        .filter((el) => el.closest(internals) === null)
        .map((el) => ({ el, r: el.getBoundingClientRect(), style: getComputedStyle(el) }))
        // Not drawn: inside a closed <details>, which Chromium still lays out (content-visibility: hidden).
        .filter(({ el, r, style }) => r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && el.checkVisibility({ contentVisibilityAuto: true }))
      const out: string[] = []
      for (let a = 0; a < targets.length; a++) {
        for (let b = a + 1; b < targets.length; b++) {
          const [x, y] = [targets[a]!, targets[b]!]
          if (x.el.contains(y.el) || y.el.contains(x.el)) continue
          const dx = Math.max(0, Math.max(x.r.left, y.r.left) - Math.min(x.r.right, y.r.right))
          const dy = Math.max(0, Math.max(x.r.top, y.r.top) - Math.min(x.r.bottom, y.r.bottom))
          const gap = Math.hypot(dx, dy)
          if (gap < min - 0.5) out.push(`${name(x.el)} | ${name(y.el)}: ${Math.round(gap)} px`)
        }
      }
      return out
    },
    [minPx, MAP_INTERNALS] as const,
  )
}
