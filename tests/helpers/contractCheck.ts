// The rules for docs/contracts/core-contract.json (#169). Pure: the test reads the files and
// passes them in, so the rules themselves can be tested on made-up snapshots.
//
// A pull request that changes a shape regenerates the declarations and adds one file
// docs/contracts/changes/<branch>.md saying what changed, for the Swift port. It does not bump
// CORE_CONTRACT_VERSION. The version is bumped once, by the pull request that brings the Swift
// port up to the web contract: it records the new version and its hash in `history` and deletes
// the change files it ported. The snapshot has no live `hash` line (it changed in every such pull
// request, so two that changed different types still conflicted); the hash is computed.

export interface ContractSnapshot {
  readonly version: number
  /** Every version there has been, oldest first, with its hash. */
  readonly history: readonly { readonly version: number; readonly hash: string }[]
  readonly declarations: Record<string, string>
}

export interface ChangeFile {
  /** The file name in docs/contracts/changes, e.g. `claude-issue-169-contract-changes.md`. */
  readonly name: string
  readonly text: string
}

export const CONTRACT_SNAPSHOT = 'docs/contracts/core-contract.json'
export const CONTRACT_CHANGES_DIR = 'docs/contracts/changes'
const REGENERATE = 'UPDATE_CONTRACT=1 npx vitest run tests/contracts.test.ts'

/** The change files among the names in docs/contracts/changes: every `.md` but the README. */
export const isChangeFile = (name: string): boolean => name.endsWith('.md') && name.toLowerCase() !== 'readme.md'

/** A change file says something: text other than headings and blank lines. */
const describesSomething = (text: string): boolean =>
  text.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('#'))

/**
 * What is wrong with the snapshot, as messages that say what to do; empty when it is right.
 *
 * - The declarations must be the source's (`surface`).
 * - The snapshot's version must be the newest in `history` and equal `version` (CORE_CONTRACT_VERSION).
 * - When the contract (`hash`) differs from the newest version's, at least one change file must
 *   describe it; when it does not differ, there must be none (the port deletes what it ported).
 * - Every change file must say something.
 */
export function contractProblems(input: {
  readonly snapshot: unknown
  readonly surface: Record<string, string>
  readonly hash: string
  readonly version: number
  readonly changeFiles: readonly ChangeFile[]
}): string[] {
  const { surface, hash, version, changeFiles } = input
  if (input.snapshot === null || typeof input.snapshot !== 'object') return [`${CONTRACT_SNAPSHOT} is missing: run ${REGENERATE}.`]
  const snapshot = input.snapshot as ContractSnapshot
  const problems: string[] = []

  if ('hash' in snapshot) problems.push(`${CONTRACT_SNAPSHOT} has a top-level "hash": the hash is computed, not stored (#169). Run ${REGENERATE}.`)

  const changed = Object.keys({ ...surface, ...snapshot.declarations }).filter((k) => surface[k] !== snapshot.declarations?.[k])
  if (changed.length > 0) problems.push(`The declarations changed (${changed.join(', ')}): run ${REGENERATE}.`)

  const latest = snapshot.history?.at(-1)
  if (latest === undefined) return [...problems, `${CONTRACT_SNAPSHOT} has no version history.`]
  if (snapshot.version !== latest.version) {
    problems.push(`${CONTRACT_SNAPSHOT} says version ${snapshot.version} but its newest history entry is ${latest.version}: run ${REGENERATE}.`)
  }
  if (version !== latest.version) {
    problems.push(
      version > latest.version
        ? `CORE_CONTRACT_VERSION is ${version} but version ${version} is not recorded: run ${REGENERATE} (only in the pull request that ports the Swift side).`
        : `CORE_CONTRACT_VERSION is ${version}, older than the recorded version ${latest.version}.`,
    )
  }

  if (hash !== latest.hash && changeFiles.length === 0) {
    problems.push(
      `The core contract changed since version ${latest.version} (${changed.join(', ') || 'the declarations are regenerated, or a schema file changed'}) ` +
        `and no file in ${CONTRACT_CHANGES_DIR} describes it: add ${CONTRACT_CHANGES_DIR}/<your-branch>.md saying what changed, for the Swift port. ` +
        'Do not bump CORE_CONTRACT_VERSION (docs/contracts.md, Changing a contract).',
    )
  }
  if (hash === latest.hash && changeFiles.length > 0) {
    problems.push(
      `The contract is exactly version ${latest.version}, but ${CONTRACT_CHANGES_DIR} still has ${changeFiles.map((f) => f.name).join(', ')}: ` +
        'a change file describes a change not yet ported; delete the ones the version bump ported (or that a later change undid).',
    )
  }
  for (const f of changeFiles) {
    if (!describesSomething(f.text)) problems.push(`${CONTRACT_CHANGES_DIR}/${f.name} says nothing: describe what changed, for the Swift port.`)
  }
  return problems
}

/**
 * The snapshot that `UPDATE_CONTRACT=1` writes. The declarations always come from the source.
 * The version and history change only when CORE_CONTRACT_VERSION is above the recorded version
 * (the Swift port's bump): the new version and the current hash are appended.
 */
export function nextSnapshot(old: ContractSnapshot | null, surface: Record<string, string>, hash: string, version: number): ContractSnapshot {
  if (old === null) return { version, history: [{ version, hash }], declarations: surface }
  const latest = old.history.at(-1)!
  if (version < latest.version) throw new Error(`CORE_CONTRACT_VERSION (${version}) is older than the recorded version ${latest.version}.`)
  if (version === latest.version) return { version: latest.version, history: old.history, declarations: surface }
  if (hash === latest.hash) throw new Error(`CORE_CONTRACT_VERSION went to ${version}, but the contract is exactly version ${latest.version}: there is nothing to record.`)
  return { version, history: [...old.history, { version, hash }], declarations: surface }
}
