import { describe, expect, it } from 'vitest'
import { bestVerified, DEFAULT_RUNS, queueReport, readPlan, type QueueResult } from '../scripts/phone/lab/queue.mjs'

// The phone lab's queue (scripts/phone/lab/queue.mjs): which build is left on the owner's
// phone at the end, and what a plan may ask for. The rule is in docs/phone-lab.md.

const there = () => true
const result = (name: string, codes: number[], extra: Partial<QueueResult> = {}): QueueResult => ({
  name,
  ipa: `${name}.ipa`,
  keep: true,
  installed: true,
  installNote: '',
  runs: codes.map((code, i) => ({ label: `run ${i + 1}`, code, summary: `# title\n\nResult ${code}` })),
  ...extra,
})

describe('which build stays on the phone', () => {
  it('the last build that passed every run', () => {
    expect(bestVerified([result('a', [0, 0]), result('b', [0, 0, 0])])?.name).toBe('b')
  })

  it('a later build that failed a run does not replace an earlier one that passed', () => {
    expect(bestVerified([result('a', [0, 0]), result('b', [0, 1])])?.name).toBe('a')
  })

  it('a run that could not be made (code 2) is not a pass', () => {
    expect(bestVerified([result('a', [0, 2])])).toBeNull()
  })

  it('nothing passed: null, which means the rollback build', () => {
    expect(bestVerified([result('a', [1]), result('b', [0, 0], { installed: false })])).toBeNull()
    expect(bestVerified([])).toBeNull()
  })

  it('a build with no runs, a build run "as found" and a throwaway build are never the one to keep', () => {
    expect(bestVerified([result('a', [])])).toBeNull()
    expect(bestVerified([result('a', [0], { ipa: null })])).toBeNull()
    expect(bestVerified([result('good', [0]), result('throwaway', [0, 0], { keep: false })])?.name).toBe('good')
  })
})

describe('reading a plan', () => {
  const plan = (builds: unknown, rollback: unknown = 'known-good.ipa') => JSON.stringify({ rollback, builds })

  it('a build gets the default runs, and may be kept, unless the plan says otherwise', () => {
    const read = readPlan(plan([{ name: 'main', ipa: 'main.ipa' }, { name: 'pr', ipa: 'pr.ipa', keep: false, runs: [['--scenario', 'drive-screen']] }]), there)
    expect(read).toEqual({
      rollback: 'known-good.ipa',
      builds: [
        { name: 'main', ipa: 'main.ipa', runs: DEFAULT_RUNS, keep: true },
        { name: 'pr', ipa: 'pr.ipa', runs: [['--scenario', 'drive-screen']], keep: false },
      ],
    })
  })

  it('no rollback build, or one that is not on disk, is refused: there must be a way back', () => {
    expect(readPlan(plan([{ name: 'a' }], null), there)).toHaveProperty('error')
    expect(readPlan(plan([{ name: 'a' }]), () => false)).toHaveProperty('error')
  })

  it('a run with --lock is refused: it ends the session and leaves the phone dark', () => {
    const read = readPlan(plan([{ name: 'a', runs: [['--scenario', 'locked-wrong-turn', '--lock', '--owner-unlocks-after']] }]), there)
    expect(read).toHaveProperty('error')
    expect('error' in read && read.error).toMatch(/--lock/)
  })

  it('the default runs do not lock the phone and do not move its position', () => {
    const flat = DEFAULT_RUNS.flat()
    expect(flat).not.toContain('--lock')
    // The drive in a queue is the in-app test drive: the owner may have the phone in hand.
    expect(DEFAULT_RUNS.filter((r) => r.includes('locked-wrong-turn')).every((r) => r.includes('--in-app'))).toBe(true)
  })

  it('a missing ipa, an empty list and text that is not JSON are refused', () => {
    expect(readPlan(plan([{ name: 'a', ipa: 'gone.ipa' }]), (f) => f !== 'gone.ipa')).toHaveProperty('error')
    expect(readPlan(plan([]), there)).toHaveProperty('error')
    expect(readPlan('not json', there)).toHaveProperty('error')
  })
})

describe('the one report', () => {
  it('says what is left on the phone, each run as passed, FAILED or INCOMPLETE, and a build that did not install', () => {
    const text = queueReport({
      startedAt: '07:00:00',
      endedAt: '07:40:00',
      results: [result('main + lab', [0, 1, 2]), result('pr 127', [], { installed: false, installNote: 'Sideloadly opened a window' })],
      left: 'the rollback build',
      note: '',
    })
    expect(text).toContain('**Left on the phone:** the rollback build')
    expect(text).toContain('| main + lab | yes | run 1: passed; run 2: FAILED; run 3: INCOMPLETE |')
    expect(text).toContain('| pr 127 | NO: Sideloadly opened a window | none |')
    expect(text).toContain('### run 2: FAILED\n\nResult 1')
  })
})
