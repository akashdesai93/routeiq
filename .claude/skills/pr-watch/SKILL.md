---
name: pr-watch
description: Review and land open RouteIQ pull requests. The reviewer routine runs it every hour (the orchestrator, or the understudy while it acts, may run it too). Each PR gets an independent review, a check of CI and the local verify, then a squash merge or a "changes requested" comment.
---

# PR watch (the lander)

Run by the **reviewer** role, or by the orchestrator or the understudy while it acts
(`docs/orchestrator.md`, Roles). Only one of them lands at a time: if a `status:` of another
lander says `state: working` within the last 60 min, review but don't land. Never review or
land a PR you wrote.

The machine now holds the gates that were conventions: `required` stays red while a PR has
`do-not-merge` or `needs-human`, has `needs-phone` (or `PHONE CHECK NEEDED` in its body)
without `phone-verified`, or is behind `main` in an area it changes. Don't work around a red
`required`; it is the answer. A PR that needs the phone and has none of the labels gets
`needs-phone` from you.

`main` is protected (`docs/branch-protection.md`): no direct pushes by anyone, and a PR
merges only when the one required check, `required` (the last job of `gate.yml`), is green,
the branch is up to date with `main`, and its review threads are resolved. The
orchestrator's own doc and skill changes go through PRs like everything else: branch from
`origin/main` in a worktree, push, open the PR, and merge it with
`gh pr merge N --squash --auto` (no agent review needed for a docs-only or skills-only PR;
anything else of the orchestrator's waits for the next iteration's review).

In the cloud `gh pr` fails. Use REST: `gh api repos/akashdesai93/routeiq/pulls/N`,
`.../pulls/N/files`, `.../commits/<sha>/check-runs?check_name=required`, and to land:

```bash
gh api -X PUT repos/akashdesai93/routeiq/pulls/N/merge -f merge_method=squash \
  -f sha=<head sha you reviewed> -f commit_title="<PR title> (#N)" -F commit_message=@msg.md
```

Always pass an explicit `commit_message` (the PR body's summary and its `Closes #N`): the
default squash message copies every commit's text, which once carried `[skip ci]` to main
(#91) and once closed the wrong issue (#145). Passing `sha` makes GitHub refuse if the PR
moved after your review.

For each open, non-draft PR on `akashdesai93/routeiq`
(`gh pr list --state open --json number,title,headRefName,isDraft,mergeable,labels,statusCheckRollup,author`):

1. **Skip** a PR that is a draft, carries `do-not-merge` or `needs-human`, or whose newest
   commit you already reviewed and that has not changed since (look for your
   `pr-watch: reviewed <sha>` comment).
2. **CI:** `gh pr checks N`. The check that decides is `required`; the others (`web / …`,
   `e2e / …`, the native and macOS jobs when they ran) say which part failed. A pending
   check is no reason to wait with the review (step 5). A failing check means comment with
   the failing job and its log tail (`gh run view --log-failed`), then stop for this PR.
   CodeQL is not required: read its annotations, and treat a new high-severity alert as a
   blocking finding.
3. **Review findings** (CLAUDE.md, "Review findings become checks"). Read Copilot's review
   comments and the CodeQL alerts on the newest commit
   (`gh api repos/akashdesai93/routeiq/pulls/N/comments`, `/pulls/N/reviews`, and the
   `CodeQL` check run's annotations). Every thread needs an outcome before the merge:
   - a **true** finding is fixed in this PR together with a guard (a test that fails
     without the fix, a lint rule or a CI step; a reviewer-checklist line only when
     nothing automated fits). A fix with no guard is a blocking finding: request changes.
   - **noise** gets a one-line reply on the thread saying why, then the thread is resolved.
   - a kind of finding you have seen before on another PR needs an automated guard, not a
     checklist line: request one, or file a `triage` issue for it.
4. **Local verify** for PRs that touch the web app (`src/`, `tests/`, `scripts/`,
   `package*.json`) when CI doesn't already run typecheck, lint and test: check the
   branch out in a scratch worktree
   (`git worktree add ../routeiq-review-N origin/<branch>`), run `npm.cmd ci` and the
   `/verify` steps there, then `git worktree remove` it. Never use the main checkout.
5. **Review:** spawn one `route-logic-reviewer` agent with the PR number, and have it
   read `gh pr diff N` itself. Native-only PRs (`native/**`, `.github/workflows/native-*`)
   are reviewed against `native/README.md` and their parity with `src/core` instead.
   Give the agent the diff, not your opinion of it.
6. **Decide**, and post the verdict as a PR comment whose first line is
   `verdict: approve <sha7>` or `verdict: changes <sha7>` (`state.mjs` reads it):
   - **Merge** when the reviewer reports no blocking finding, every Copilot and CodeQL
     thread has an outcome (step 3), verify is green, the PR has
     no conflicts, and the PR body says how it was verified. Use
     `gh pr merge N --squash --auto`: GitHub merges it as soon as `required` is green, and
     refuses while it is red, so there is no merging on red CI. If GitHub says the branch
     is out of date, run `gh pr update-branch N` (the gate runs again and auto-merge
     finishes). Queue one PR at a time, since each merge makes the others out of date.
     GitHub deletes the head branch on merge; the author restarts from `origin/main`.
     Once it has merged (`gh pr view N --json state,mergeCommit`; next iteration if the
     checks are still running):
     - comment `pr-watch: merged <sha>`;
     - tell the author to restart from `origin/main` (`mcp__fleet__send` for a local
       session; nothing for a cloud one, which reads its PR);
     - flip any issue it closes to closed if GitHub didn't;
     - in each issue that said "Blocked by" this one, swap `blocked` for `ready`.
   - **Request changes** when there are blocking findings. Post
     `gh pr review N --request-changes -b "<findings with file:line>"` and comment
     `pr-watch: reviewed <sha>`. Message the author session.
   - **Escalate** with `needs-human` and a comment when the PR changes product behaviour
     beyond its issue, touches licensing, privacy or tokens, deletes data, or changes
     CI permissions or secrets. Name the PR in the next status update to the owner.
7. Record each outcome on the status board (see the `status` skill).

Never use `--admin`, never force-push, never push to `main`, and never take branch
protection off: only the owner does that. If GitHub Actions is down (runs queued with no
jobs), nothing can merge; tell the owner instead of working around it.

**After every merge:** strip `ready`, `in-progress`, `review` and `blocked` from the closed
issues (through the REST API, since `gh issue edit` hits a Projects-classic error). Then
check the newest Gate run on main. If it is red, stop landing; `main-red.yml` opens the
`main is red` issue, and the first session to claim it there fixes it.

**Pace:** land one PR, then the next only after `required` on it has re-run if the area
gate turned it red. A tick with nothing to review or land posts nothing.
