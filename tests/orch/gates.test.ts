import { describe, expect, it } from 'vitest'
import { areasOf, evaluate, recheckMain, rerunRequired } from '../../scripts/orch/gates.mjs'

// The gates the Gate's `required` job holds (docs/orchestrator.md). Each case is planted from
// what really went wrong on the first night: a rule that lived only in a prompt let it through.

// File lists as GitHub reports them for those PRs.
const PR_91 = ['.github/workflows/shell-ios.yml', '.github/workflows/sim-drive.yml', 'native/shell/README.md', 'native/shell/scripts/build-web.mjs', 'native/shell/sim/drive.mjs', 'native/shell/sim/stub.mjs', 'native/shell/tests/sim.test.mjs']
const PR_121 = ['native/shell/package-lock.json', 'native/shell/package.json', 'native/shell/scripts/info-plist.mjs', 'native/shell/tests/shell.test.mjs']
const PR_126 = ['docs/contracts.md', 'native/RouteIQCore/Sources/RouteIQCore/Contract.swift', 'native/RouteIQCore/Sources/RouteIQCore/Reroute.swift', 'native/scripts/signal-parity-reference.mjs']
const PR_135 = ['docs/contracts/core-contract.json', 'src/core/contract.ts', 'src/core/live.ts', 'native/RouteIQCore/Sources/RouteIQCore/Live.swift', 'e2e/switch.spec.ts', 'README.md']
const PR_158_BODY = 'Part of #145.\n\n**PHONE CHECK NEEDED before merge.** At night the iPhone draws a different Mapbox style, and CI can\'t prove that with a real style.'
const PR_158 = ['README.md', 'src/map/MapView.tsx', 'src/map/mapTheme.ts', 'tests/mapTheme.test.ts']
const DOCS = ['README.md', 'docs/orchestrator.md', '.claude/skills/status/SKILL.md', 'PLAN.md']

const pr = (over: Partial<{ labels: string[]; body: string; files: string[] }> = {}) => ({ labels: [], body: '', files: ['src/App.tsx'], ...over })
const gates = (r: ReturnType<typeof evaluate>) => r.failures.map((f) => f.gate)

describe('phone gate', () => {
  it('holds #158, whose body asked for a phone check that the reviewer missed', () => {
    const r = evaluate(pr({ body: PR_158_BODY, files: PR_158 }), { aheadBy: 0, files: [] })
    expect(gates(r)).toEqual(['phone'])
    expect(r.failures[0].message).toMatch(/PHONE CHECK NEEDED/)
  })

  it('holds a PR labelled needs-phone, whatever paths it touches', () => {
    expect(gates(evaluate(pr({ labels: ['needs-phone'], files: ['src/index.css'] }), null))).toEqual(['phone'])
  })

  it('lets it through once the phone lab added phone-verified', () => {
    expect(evaluate(pr({ labels: ['needs-phone', 'phone-verified'], body: PR_158_BODY }), null).ok).toBe(true)
  })

  it('does not hold a PR that only quotes the marker (#159, and #167 explaining this gate)', () => {
    expect(evaluate(pr({ body: '#158\'s own description said **"PHONE CHECK NEEDED before merge"**: at night' }), null).ok).toBe(true)
    expect(evaluate(pr({ body: '| phone | `needs-phone`, or `PHONE CHECK NEEDED` in the body |' }), null).ok).toBe(true)
    expect(gates(evaluate(pr({ body: 'Battery.\n\nPHONE CHECK NEEDED before merge' }), null))).toEqual(['phone'])
  })

  it('does not hold a PR that only talks about phones', () => {
    expect(evaluate(pr({ body: 'Fixes the phone lab report test.' }), null).ok).toBe(true)
  })
})

describe('hold labels', () => {
  it.each(['do-not-merge', 'needs-human'])('holds a PR with %s', (label) => {
    expect(gates(evaluate(pr({ labels: [label] }), null))).toEqual(['hold'])
  })
})

describe('up to date by area', () => {
  it('holds #91 once #121 changed the same package on main (green alone, red together)', () => {
    const r = evaluate(pr({ files: PR_91 }), { aheadBy: 1, files: PR_121 })
    expect(gates(r)).toEqual(['up-to-date'])
    expect(r.failures[0].message).toContain('native-shell')
  })

  it('holds a web PR whose checks ran before a test file changed on main (the orchestrator\'s case)', () => {
    expect(gates(evaluate(pr({ files: PR_158 }), { aheadBy: 1, files: ['tests/lab.test.ts'] }))).toEqual(['up-to-date'])
  })

  it('holds #135 once #126 changed the Swift core it also ports to (contract version)', () => {
    expect(gates(evaluate(pr({ files: PR_135 }), { aheadBy: 3, files: PR_126 }))).toEqual(['up-to-date'])
  })

  it('does not hold a PR when main only changed docs', () => {
    expect(evaluate(pr({ files: PR_91 }), { aheadBy: 4, files: DOCS }).ok).toBe(true)
  })

  it('does not hold a PR in another area', () => {
    expect(evaluate(pr({ files: PR_158 }), { aheadBy: 2, files: PR_121 }).ok).toBe(true)
  })

  it('never holds a docs-only PR', () => {
    expect(evaluate(pr({ files: DOCS }), { aheadBy: 9, files: PR_158 }).ok).toBe(true)
  })

  it('holds when main changed more files than the compare API lists', () => {
    const many = Array.from({ length: 300 }, (_, i) => `docs/x${i}.md`)
    expect(gates(evaluate(pr({ files: PR_158 }), { aheadBy: 40, files: many }))).toEqual(['up-to-date'])
  })

  it('reports every gate that fails at once', () => {
    expect(gates(evaluate(pr({ labels: ['do-not-merge', 'needs-phone'], files: PR_91 }), { aheadBy: 1, files: PR_121 }))).toEqual(['hold', 'phone', 'up-to-date'])
  })
})

describe('areasOf', () => {
  it('maps paths to the areas that can break each other', () => {
    expect(areasOf('native/shell/sim/stub.mjs')).toEqual(['native-shell'])
    expect(areasOf('docs/contracts/core-contract.json')).toEqual(['web', 'native-core'])
    expect(areasOf('package.json')).toEqual(['web', 'native-shell'])
    expect(areasOf('docs/phone-lab.md')).toEqual([])
    expect(areasOf('scripts/orch/gates.mjs')).toEqual(['web'])
    expect(areasOf('something/new.ts')).toEqual(['web'])
  })
})

describe('list-item markers (reviewers write PHONE CHECK NEEDED as a bullet too)', () => {
  it.each(['- **PHONE CHECK NEEDED** before merge', '* PHONE CHECK NEEDED', '+ PHONE CHECK NEEDED', '1. PHONE CHECK NEEDED: lock the phone'])('holds %j', (line) => {
    expect(gates(evaluate(pr({ body: `Battery.\n\n${line}` }), null))).toEqual(['phone'])
  })
  it('still lets a bullet that only quotes it through', () => {
    expect(evaluate(pr({ body: '- the gate reads `PHONE CHECK NEEDED` at the start of a line' }), null).ok).toBe(true)
  })
})

describe('CI area', () => {
  it('holds a PR that changes gate.yml once another change to gate.yml landed on main', () => {
    expect(gates(evaluate(pr({ files: ['.github/workflows/gate.yml'] }), { aheadBy: 1, files: ['.github/workflows/gate.yml'] }))).toEqual(['up-to-date'])
  })
  it('does not hold a CI-only PR when main changed only the web app', () => {
    expect(evaluate(pr({ files: ['.github/workflows/gates.yml'] }), { aheadBy: 1, files: ['src/App.tsx'] }).ok).toBe(true)
  })
})

// A recording `gh`: Gate runs per call, the required job, and every POST it was asked to make.
function fakeGh(statuses: string[]) {
  const posts: string[] = []
  let i = 0
  const call = (path: string, method = 'GET') => {
    if (method !== 'GET') {
      posts.push(path)
      return null
    }
    if (path.includes('/actions/workflows/gate.yml/runs')) return { workflow_runs: [{ id: 7, status: statuses[Math.min(i++, statuses.length - 1)] }] }
    if (path.includes('/actions/runs/7/jobs')) return { jobs: [{ id: 99, name: 'required' }] }
    throw new Error(`unexpected ${path}`)
  }
  return { call, posts }
}
const quiet = { sleep: async () => {}, log: () => {}, wait: { pollMs: 1, maxMs: 10 } }

describe('re-check when a label changes', () => {
  it('re-runs required of a Gate run that is still going (required already green, e2e-report not done)', async () => {
    const { call, posts } = fakeGh(['in_progress', 'in_progress', 'completed'])
    expect(await rerunRequired('R', 'abc1234', { ...quiet, gh: call })).toBe('rerun')
    expect(posts).toEqual(['R/actions/jobs/99/rerun'])
  })
  it('re-runs required of a finished run straight away', async () => {
    const { call, posts } = fakeGh(['completed'])
    expect(await rerunRequired('R', 'abc1234', { ...quiet, gh: call })).toBe('rerun')
    expect(posts).toEqual(['R/actions/jobs/99/rerun'])
  })
  it('fails, rather than passing quietly, when the run never finishes', async () => {
    const { call, posts } = fakeGh(['in_progress'])
    await expect(rerunRequired('R', 'abc1234', { ...quiet, gh: call })).rejects.toThrow(/still in_progress/)
    expect(posts).toEqual([])
  })
  it('re-runs nothing on a dry run', async () => {
    const { call, posts } = fakeGh(['completed'])
    expect(await rerunRequired('R', 'abc1234', { ...quiet, gh: call, dry: true })).toBe('dry-run')
    expect(posts).toEqual([])
  })
})

describe('re-check after a push to main', () => {
  it('one PR that errors does not stop the others being re-checked, and is reported', async () => {
    const reran: string[] = []
    const call = (path: string) => {
      if (path.includes('/pulls?state=open')) return [{ number: 1, head: { sha: 'aaa' } }, { number: 2, head: { sha: 'bbb' } }]
      if (path.includes('/pulls/1/files')) throw new Error('HTTP 404')
      if (path.includes('/pulls/2/files')) return [{ filename: 'src/App.tsx' }]
      if (path.includes('/check-runs')) return { check_runs: [{ conclusion: 'success', started_at: '2026-11-12T10:00:00Z' }] }
      throw new Error(`unexpected ${path}`)
    }
    const errors = await recheckMain('R', { pushed: ['src/core/live.ts'], pushedAt: '2026-11-12T11:00:00Z', gh: call, log: () => {}, rerun: async (_R, sha) => void reran.push(sha) })
    expect(reran).toEqual(['bbb'])
    expect(errors).toEqual([{ pr: 1, message: 'HTTP 404' }])
  })
})
