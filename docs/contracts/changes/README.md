# Contract changes not yet ported

One file per pull request that changes a shape of the core contract (#169), named after its
branch with `/` as `-`: `claude/issue-175-check-outcomes` → `claude-issue-175-check-outcomes.md`.
It says what changed, for the Swift port: the types and fields, and what the port has to do.

A pull request that changes a shape does **not** bump `CORE_CONTRACT_VERSION`. The pull request
that brings the Swift port up to the web contract bumps it once, records the version
(`UPDATE_CONTRACT=1 npx vitest run tests/contracts.test.ts`), moves these notes into the
Changes list of [docs/contracts.md](../../contracts.md) and deletes them.

`tests/contracts.test.ts` fails while the contract differs from the newest recorded version and
no file here describes it, and while a file here is left after the contract is exactly that version.

Example:

```md
# claude-issue-175-check-outcomes (#175)

- `LiveState.lastDecision` gains `routes: number | null` (how many routes the check's answer
  had) and `savingSec: number | null` (the considered alternative's like-for-like saving).
- Swift: add both to `Live.swift`'s `LastDecision`; no rule changes.
```
