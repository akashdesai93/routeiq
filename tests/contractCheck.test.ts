import { describe, expect, it } from 'vitest'
import { contractProblems, isChangeFile, nextSnapshot, type ContractSnapshot } from './helpers/contractCheck.ts'

// #169: a shape change is described in a per-PR change file instead of bumping the version in
// every pull request; the version is bumped once, by the pull request that ports the Swift side.

const V6 = 'hash-of-6'
const surface = { LiveState: 'interface LiveState { readonly a : number }' }
const changedSurface = { LiveState: 'interface LiveState { readonly a : number readonly b : number }' }
const snap6: ContractSnapshot = { version: 6, history: [{ version: 5, hash: 'hash-of-5' }, { version: 6, hash: V6 }], declarations: surface }
const note = { name: 'claude-issue-175-check-outcomes.md', text: '# LiveState\n\n`LiveState.lastDecision` gains `routes`.\n' }
const check = (over: Partial<Parameters<typeof contractProblems>[0]>) =>
  contractProblems({ snapshot: snap6, surface, hash: V6, version: 6, changeFiles: [], ...over })

describe('contract snapshot rules (#169)', () => {
  it('passes when the contract is exactly the newest version and nothing is pending', () => {
    expect(check({})).toEqual([])
  })

  it('a change of shape fails until a change file describes it, and passes without a version bump', () => {
    const changed = { snapshot: { ...snap6, declarations: changedSurface }, surface: changedSurface, hash: 'hash-new' }
    const without = check(changed)
    expect(without).toHaveLength(1)
    expect(without[0]).toContain('docs/contracts/changes/<your-branch>.md')
    expect(without[0]).toContain('Do not bump CORE_CONTRACT_VERSION')
    expect(check({ ...changed, changeFiles: [note] })).toEqual([])
  })

  it('a schema edit (same declarations, new hash) also needs a change file', () => {
    expect(check({ hash: 'hash-schema-edited' })).toHaveLength(1)
    expect(check({ hash: 'hash-schema-edited', changeFiles: [note] })).toEqual([])
  })

  it('declarations that are not regenerated fail, change file or not, and name the type', () => {
    const problems = check({ surface: changedSurface, hash: 'hash-new', changeFiles: [note] })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('LiveState')
    expect(problems[0]).toContain('UPDATE_CONTRACT=1')
  })

  it('a change file that says nothing does not count as a description', () => {
    const empty = { name: 'claude-x.md', text: '# claude-x\n\n' }
    const problems = check({ snapshot: { ...snap6, declarations: changedSurface }, surface: changedSurface, hash: 'hash-new', changeFiles: [empty] })
    expect(problems).toEqual([expect.stringContaining('claude-x.md says nothing')])
  })

  it('change files left behind after the port recorded the version fail', () => {
    const problems = check({ changeFiles: [note] })
    expect(problems).toEqual([expect.stringContaining('still has claude-issue-175-check-outcomes.md')])
  })

  it('the snapshot keeps no live hash line', () => {
    expect(check({ snapshot: { ...snap6, hash: V6 } })).toEqual([expect.stringContaining('top-level "hash"')])
  })

  it('a version bump that is not recorded, or a version going back, fails', () => {
    expect(check({ version: 7, hash: 'hash-new', changeFiles: [note] })).toEqual([expect.stringContaining('version 7 is not recorded')])
    expect(check({ version: 5 })).toEqual([expect.stringContaining('older than the recorded version 6')])
    expect(check({ snapshot: { ...snap6, version: 5 } })).toEqual([expect.stringContaining('says version 5 but its newest history entry is 6')])
  })

  it('the README in the changes folder is not a change file', () => {
    expect(isChangeFile('README.md')).toBe(false)
    expect(isChangeFile('claude-issue-169-contract-changes.md')).toBe(true)
    expect(isChangeFile('.gitkeep')).toBe(false)
  })
})

describe('UPDATE_CONTRACT=1 (#169)', () => {
  it('without a bump it regenerates the declarations only: version and history stay', () => {
    const next = nextSnapshot(snap6, changedSurface, 'hash-new', 6)
    expect(next).toEqual({ version: 6, history: snap6.history, declarations: changedSurface })
  })

  it('drops a stored top-level hash from an old snapshot', () => {
    const next = nextSnapshot({ ...snap6, hash: V6 } as ContractSnapshot, surface, V6, 6)
    expect('hash' in next).toBe(false)
  })

  it('the port bump records the new version with the current hash', () => {
    const next = nextSnapshot(snap6, changedSurface, 'hash-new', 7)
    expect(next.version).toBe(7)
    expect(next.history.at(-1)).toEqual({ version: 7, hash: 'hash-new' })
    expect(next.history).toHaveLength(3)
  })

  it('refuses a bump with nothing to record, and a version going back', () => {
    expect(() => nextSnapshot(snap6, surface, V6, 7)).toThrow(/nothing to record/)
    expect(() => nextSnapshot(snap6, surface, V6, 5)).toThrow(/older/)
  })
})
