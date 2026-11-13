import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The controls guard (e2e/controls-guard.mjs, #203): a control that is on screen in some e2e
// scenario and tapped by none fails the run, unless e2e/controls-untested.json gives the reason;
// a line of that list whose control is tapped now (or gone) fails it too.

const GUARD = resolve('e2e/controls-guard.mjs')

interface Run {
  title: string
  seen: string[]
  activated: string[]
}

function guard(runs: Run[], untested: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'controls-guard-'))
  runs.forEach((run, i) => {
    mkdirSync(join(dir, 'results', `scenario-${i}`), { recursive: true })
    writeFileSync(join(dir, 'results', `scenario-${i}`, 'controls.json'), JSON.stringify({ project: '', ...run }))
  })
  writeFileSync(join(dir, 'untested.json'), JSON.stringify({ untested }))
  const result = spawnSync(process.execPath, [GUARD, '--untested', join(dir, 'untested.json'), join(dir, 'results')], { cwd: dir, encoding: 'utf8' })
  return { status: result.status, out: result.stdout + result.stderr, report: readFileSync(join(dir, 'e2e-report', 'controls.md'), 'utf8') }
}

const START = 'Routes › button "Start drive"'
const PLANTED = 'Plan a trip › button "Planted"'

describe('controls guard', () => {
  it('passes when every control on screen is tapped by some scenario, in any scenario', () => {
    const result = guard([
      { title: 'plan', seen: [START, PLANTED], activated: [PLANTED] },
      { title: 'drive', seen: [START], activated: [START] },
    ])
    expect(result.status).toBe(0)
    expect(result.out).toContain('2 controls on screen, 2 tapped by a scenario, 0 not')
  })

  it('fails on a planted button that no scenario taps, and names it', () => {
    const result = guard([{ title: 'plan', seen: [START, PLANTED], activated: [START] }])
    expect(result.status).toBe(1)
    expect(result.out).toContain(`not tapped by any scenario: ${PLANTED}`)
    expect(result.report).toContain(`| ${PLANTED} | **no** |`)
  })

  it('a click that only reached the control in code does not count: activated is what the page saw as trusted', () => {
    // The recorder (e2e/controls.ts) never puts an untrusted click in `activated`, so seen-only is untapped.
    const result = guard([{ title: 'plan', seen: [PLANTED], activated: [] }])
    expect(result.status).toBe(1)
  })

  it('passes on an untapped control that the list gives a reason for', () => {
    const result = guard([{ title: 'plan', seen: [START, PLANTED], activated: [START] }], { [PLANTED]: 'its tap opens a page, #999' })
    expect(result.status).toBe(0)
    expect(result.report).toContain('listed: its tap opens a page, #999')
  })

  it('fails on a line of the list whose control is tapped now, so the list only shrinks', () => {
    const result = guard([{ title: 'plan', seen: [START, PLANTED], activated: [START, PLANTED] }], { [PLANTED]: 'not yet' })
    expect(result.status).toBe(1)
    expect(result.out).toContain(`a scenario taps it now: ${PLANTED}`)
  })

  it('fails on a line of the list whose control no scenario shows any more', () => {
    const result = guard([{ title: 'plan', seen: [START], activated: [START] }], { [PLANTED]: 'not yet' })
    expect(result.status).toBe(1)
    expect(result.out).toContain(`no scenario shows it any more: ${PLANTED}`)
  })
})
