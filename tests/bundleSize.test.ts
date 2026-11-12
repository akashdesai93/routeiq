import { describe, expect, it } from 'vitest'
import { budgetProblems, ceilingRows, growthReport, headroomReport } from '../scripts/bundle-size.mjs'

// #170: the bundle has a ceiling the owner sets, not "measured + 10 %" re-based in feature PRs.
const budget = { ceiling: { appJs: 460_000, css: 80_000 }, growthPerPr: { appJs: 4000, css: 2000 }, alertAt: 0.9 }

describe('bundle ceiling (#170)', () => {
  it('a build above the ceiling is over; at the ceiling it is not', () => {
    const rows = ceilingRows({ appJs: 460_001, css: 80_000 }, budget)
    expect(rows.map((r) => [r.key, r.over])).toEqual([['appJs', true], ['css', false]])
  })

  it('the shipped budget file has every number the checks need', async () => {
    const shipped = (await import('../scripts/bundle-budget.json', { with: { type: 'json' } })).default
    expect(budgetProblems(shipped)).toEqual([])
    // The growth limits the owner chose with option (a) on #170.
    expect(shipped.growthPerPr).toEqual({ appJs: 4000, css: 2000 })
    expect(shipped.alertAt).toBe(0.9)
  })

  it('a budget in the old "measured + 10 %" shape is refused, not read as no limit', () => {
    const old = { appJs: { measured: 416_046, budget: 457_651 }, css: { measured: 72_105, budget: 79_316 } }
    expect(budgetProblems(old)).toHaveLength(5)
    expect(budgetProblems({ ...budget, alertAt: 90 })).toEqual([expect.stringContaining('alertAt')])
    expect(budgetProblems({ ...budget, growthPerPr: { appJs: 0, css: 2000 } })).toEqual([expect.stringContaining('growthPerPr.appJs')])
  })

  it('reports what a PR adds, with the limit, for the Gate', () => {
    expect(growthReport({ appJs: 413_800, css: 72_105 }, { appJs: 418_000, css: 72_000 }, budget)).toEqual({
      appJs: { base: 413_800, pr: 418_000, limit: 4000 },
      css: { base: 72_105, pr: 72_000, limit: 2000 },
    })
  })

  it('reports main\'s sizes against the ceiling for the board', () => {
    expect(headroomReport({ appJs: 417_789, css: 72_395 }, budget)).toEqual({
      alertAt: 0.9,
      appJs: { size: 417_789, ceiling: 460_000 },
      css: { size: 72_395, ceiling: 80_000 },
    })
  })
})
