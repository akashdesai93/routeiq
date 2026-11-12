---
name: pr-watch
description: Review and merge open RouteIQ pull requests. The orchestrator session runs it each loop iteration. Each PR gets an independent review, a check of CI and the local verify, then a squash merge or a "changes requested" comment.
---

# PR watch (orchestrator only)

Only the orchestrator session runs this (see "Coordination" in CLAUDE.md). It never
reviews or merges a PR that it wrote in the same iteration.

`main` is protected (`docs/branch-protection.md`): no direct pushes by anyone, and a PR
merges only when the one required check, `required` (the last job of `gate.yml`), is green,
the branch is up to date with `main`, and its review threads are resolved. The
orchestrator's own doc and skill changes go through PRs like everything else: branch from
`origin/main` in a worktree, push, open the PR, and merge it with
`gh pr merge N --squash --auto` (no agent review needed for a docs-only or skills-only PR;
anything else of the orchestrator's waits for the next iteration's review).

For each open, non-draft PR on `akashdesai93/routeiq`
(`gh pr list --state open --json number,title,headRefName,isDraft,mergeable,labels,statusCheckRollup,author`):

1. **Skip** a PR that is a draft, carries `do-not-merge` or `needs-human`, or whose newest
   commit you already reviewed and that has not changed since (look for your
   `pr-watch: reviewed <sha>` comment).
2. **CI:** `gh pr checks N`. The check that decides is `required`; the others (`web / …`,
   `e2e / …`, the native and macOS jobs when they ran) say which part failed. A pending
   check is no reason to wait with the review (step 4). A failing check means comment with
   the failing job and its log tail (`gh run view --log-failed`), then stop for this PR.
   CodeQL is not required: read its annotations, and treat a new high-severity alert as a
   blocking finding.
3. **Local verify** for PRs that touch the web app (`src/`, `tests/`, `scripts/`,
   `package*.json`) when CI doesn't already run typecheck, lint and test: check the
   branch out in a scratch worktree
   (`git worktree add ../routeiq-review-N origin/<branch>`), run `npm.cmd ci` and the
   `/verify` steps there, then `git worktree remove` it. Never use the main checkout.
4. **Review:** spawn one `route-logic-reviewer` agent with the PR number, and have it
   read `gh pr diff N` itself. Native-only PRs (`native/**`, `.github/workflows/native-*`)
   are reviewed against `native/README.md` and their parity with `src/core` instead.
   Give the agent the diff, not your opinion of it.
5. **Decide:**
   - **Merge** when the reviewer reports no blocking finding, verify is green, the PR has
     no conflicts, and the PR body says how it was verified. Use
     `gh pr merge N --squash --auto`: GitHub merges it as soon as `required` is green, and
     refuses while it is red, so there is no merging on red CI. If GitHub says the branch
     is out of date, run `gh pr update-branch N` (the gate runs again and auto-merge
     finishes). Queue one PR at a time, since each merge makes the others out of date.
     GitHub deletes the head branch on merge; the author restarts from `origin/main`.
     Once it has merged (`gh pr view N --json state,mergeCommit`; next iteration if the
     checks are still running):
     - comment `pr-watch: merged <sha>`;
     - send the author session a message to rebase or restart from `origin/main`
       (`mcp__fleet__send`, or a PR comment if it isn't live);
     - flip any issue it closes to closed if GitHub didn't;
     - in each issue that said "Blocked by" this one, swap `blocked` for `ready`.
   - **Request changes** when there are blocking findings. Post
     `gh pr review N --request-changes -b "<findings with file:line>"` and comment
     `pr-watch: reviewed <sha>`. Message the author session.
   - **Escalate** with `needs-human` and a comment when the PR changes product behaviour
     beyond its issue, touches licensing, privacy or tokens, deletes data, or changes
     CI permissions or secrets. Name the PR in the next status update to the owner.
6. Record each outcome on the status board (see the `status` skill).

Never use `--admin`, never force-push, never push to `main`, and never take branch
protection off: only the owner does that. If GitHub Actions is down (runs queued with no
jobs), nothing can merge; tell the owner instead of working around it.

**After every merge:** strip `ready`, `in-progress`, `review` and `blocked` from the closed
issues (through the REST API, since `gh issue edit` hits a Projects-classic error). Then
check `gh run list --branch main --limit 3`. If CI on main is red, stop merging, send a
PushNotification to the owner, and file a p1 issue for it.
