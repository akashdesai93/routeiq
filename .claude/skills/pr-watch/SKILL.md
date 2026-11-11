---
name: pr-watch
description: Review and merge open RouteIQ pull requests. The orchestrator session runs it each loop iteration. Each PR gets an independent review, a check of CI and the local verify, then a squash merge or a "changes requested" comment.
---

# PR watch (orchestrator only)

Only the orchestrator session runs this (see "Coordination" in CLAUDE.md). It never
reviews or merges a PR that it wrote in the same iteration.

For each open, non-draft PR on `akashdesai93/routeiq`
(`gh pr list --state open --json number,title,headRefName,isDraft,mergeable,labels,statusCheckRollup,author`):

1. **Skip** a PR that is a draft, carries `do-not-merge` or `needs-human`, or whose newest
   commit you already reviewed and that has not changed since (look for your
   `pr-watch: reviewed <sha>` comment).
2. **CI:** `gh pr checks N`. A pending check means come back next iteration. A failing
   check means comment with the failing job and its log tail (`gh run view --log-failed`),
   then stop for this PR.
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
   - **Merge** when CI and verify are green, the reviewer reports no blocking finding,
     `mergeable` is true, and the PR body says how it was verified. Use
     `gh pr merge N --squash`. Don't delete the branch, since its session may still be on it.
     Then:
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

Never use `--admin`, never force-push, and never merge red CI. If GitHub Actions is down
(runs queued with no jobs), ask the owner before merging on a local verify.

**After every merge:** strip `ready`, `in-progress`, `review` and `blocked` from the closed
issues (through the REST API, since `gh issue edit` hits a Projects-classic error). Then
check `gh run list --branch main --limit 3`. If CI on main is red, stop merging, send a
PushNotification to the owner, and file a p1 issue for it.
