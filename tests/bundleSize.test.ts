import { describe, expect, it } from 'vitest'
import { budgetProblems, ceilingRows, growthReport, headroomReport, measuredSizes, upFrontNames } from '../scripts/bundle-size.mjs'

// #170: the bundle has a ceiling the owner sets, not "measured + 10 %" re-based in feature PRs.
const budget = {
  ceiling: { appJs: 460_000, css: 80_000, entryJs: 452_123, entryCss: 25_822 },
  growthPerPr: { appJs: 4000, css: 2000, entryJs: 4000, entryCss: 2000 },
  alertAt: 0.9,
}

describe('bundle ceiling (#170)', () => {
  it('a build above the ceiling is over; at the ceiling it is not', () => {
    const rows = ceilingRows({ appJs: 460_001, css: 80_000, entryJs: 452_124, entryCss: 25_822 }, budget)
    expect(rows.map((r) => [r.key, r.over])).toEqual([['appJs', true], ['css', false], ['entryJs', true], ['entryCss', false]])
  })

  it('the shipped budget file has every number the checks need', async () => {
    const shipped = (await import('../scripts/bundle-budget.json', { with: { type: 'json' } })).default
    expect(budgetProblems(shipped)).toEqual([])
    // The ceiling the owner set on #170 (option (b)): changing it is an owner decision.
    // entryJs / entryCss: what loads before first paint, the owner's option (b) on #97 (2026-11-13).
    expect(shipped.ceiling).toEqual({ appJs: 480_000, css: 85_000, entryJs: 480_000, entryCss: 30_000 })
    // The growth limits the owner chose with option (a) on #170.
    expect(shipped.growthPerPr).toEqual({ appJs: 4000, css: 2000, entryJs: 4000, entryCss: 2000 })
    expect(shipped.alertAt).toBe(0.9)
  })

  it('a budget in the old "measured + 10 %" shape is refused, not read as no limit', () => {
    const old = { appJs: { measured: 416_046, budget: 457_651 }, css: { measured: 72_105, budget: 79_316 } }
    expect(budgetProblems(old)).toHaveLength(9)
    expect(budgetProblems({ ...budget, alertAt: 90 })).toEqual([expect.stringContaining('alertAt')])
    expect(budgetProblems({ ...budget, growthPerPr: { ...budget.growthPerPr, appJs: 0 } })).toEqual([expect.stringContaining('growthPerPr.appJs')])
  })

  it('reports what a PR adds, with the limit, for the Gate', () => {
    expect(
      growthReport({ appJs: 413_800, css: 72_105, entryJs: 400_000, entryCss: 23_000 }, { appJs: 418_000, css: 72_000, entryJs: 405_000, entryCss: 23_000 }, budget),
    ).toEqual({
      appJs: { base: 413_800, pr: 418_000, limit: 4000 },
      css: { base: 72_105, pr: 72_000, limit: 2000 },
      entryJs: { base: 400_000, pr: 405_000, limit: 4000 },
      entryCss: { base: 23_000, pr: 23_000, limit: 2000 },
    })
  })

  it('reports main\'s sizes against the ceiling for the board', () => {
    expect(headroomReport({ appJs: 417_789, css: 72_395, entryJs: 411_020, entryCss: 23_474 }, budget)).toEqual({
      alertAt: 0.9,
      appJs: { size: 417_789, ceiling: 460_000 },
      css: { size: 72_395, ceiling: 80_000 },
      entryJs: { size: 411_020, ceiling: 452_123 },
      entryCss: { size: 23_474, ceiling: 25_822 },
    })
  })

  it('counts only what index.html loads before first paint as up front (#97)', () => {
    const html = '<script type="module" src="/assets/index-AAAAAAAA.js"></script><link rel="stylesheet" href="./assets/index-BBBBBBBB.css">'
    const upFront = upFrontNames(html)
    const file = (name: string, kind: string, size: number) => ({ name, kind, upFront: upFront.has(name), size, gzip: 0 })
    const sizes = measuredSizes([
      file('index-AAAAAAAA.js', 'appJs', 400_000),
      file('LazyMapView-CCCCCCCC.js', 'appJs', 6_000),
      file('mapbox-gl-DDDDDDDD.js', 'mapbox', 1_300_000),
      file('index-BBBBBBBB.css', 'css', 16_000),
      file('LazyMapView-EEEEEEEE.css', 'css', 49_000),
    ])
    // The lazy map chunk and its CSS count as the app's, but not as loaded before first paint.
    expect(sizes).toEqual({ appJs: 406_000, css: 65_000, entryJs: 400_000, entryCss: 16_000 })
  })
})
