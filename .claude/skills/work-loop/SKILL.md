---
name: work-loop
description: One iteration of RouteIQ's autonomous work loop. It syncs the GitHub issue board, claims the top ready issue, builds it in an isolated worktree, verifies it and opens a PR. When nothing is ready, it finds new work instead. Run it as `/loop /work-loop` (self-paced) or `/loop 45m /work-loop`.
---

# RouteIQ work loop: one iteration

The repo is `akashdesai93/routeiq`, and the GitHub issues are the task list. Labels:
`ready`, `in-progress`, `blocked`, `needs-human`, `triage`, `review`, `p1`/`p2`/`p3`, `area:*`.
Read `CLAUDE.md` first if it isn't in context already.

Several Claude sessions may run at once, so follow the claim and worktree rules exactly.

## 0. Look around (always)

- `rtk git status` and `git worktree list`. Uncommitted changes in the main checkout belong
  to someone else. Never edit, stash, reset or commit them.
- Use `ListAgents` to see other sessions. If one is clearly working on the issue you were
  about to pick, skip that issue.
- `gh pr list -R akashdesai93/routeiq --state open` and `gh issue list -R akashdesai93/routeiq --state open --limit 100 --json number,title,labels`.

## 1. Sync the board

- **Merged PRs:** for each issue closed since the last iteration, find the open issues
  that say `Blocked by #N` in their body or comments. If all their blockers are closed,
  swap `blocked` for `ready`.
- **Stale claims:** an `in-progress` issue with no commit, PR or comment for over 24 h,
  whose claimant isn't in `ListAgents`, gets a comment saying so. Unclaim it only if a
  `claude-loop` session made the claim. Never unclaim #1 or anything a human claimed.
- **Reviewed PRs:** a PR of yours with review comments asking for changes becomes the work
  item for this iteration, ahead of new issues. Address the comments in its worktree.

## 2. Pick one issue

Pick from open issues labelled `ready` and not labelled `in-progress`, `blocked`,
`needs-human` or `review`. Order by p1, then p2, then p3, then the lowest number.
Skip any issue whose files overlap with uncommitted work in the main checkout. If none
qualifies, go to step 6 (Discover).

**Claim it:** `gh issue edit N --add-label in-progress`, then post the comment
`claude-loop: claimed by session <your session id or name>, worktree claude/issue-N`.
Re-read the comments. If another claim landed before yours, drop your label change and pick again.

## 3. Build it in a worktree

- `EnterWorktree` on branch `claude/issue-N-<short-slug>`, starting from `origin/main`
  (`git fetch` first). All edits happen there, never in the main checkout.
- `npm.cmd ci` if `node_modules` is missing in the worktree.
- Follow "How to build a step" in CLAUDE.md: core logic and tests first, then wiring,
  then README and PLAN updates. Keep the scope to what the issue says. Anything else you
  notice becomes a new `triage` issue, not part of this change.
- If the issue turns out to need an owner decision, add `needs-human`, remove
  `in-progress`, comment the specific question, leave the worktree, and pick again
  (at most once per iteration).

## 4. Verify

- Run `/verify`. Everything must be green.
- Run the `route-logic-reviewer` agent on the diff when `src/core`, `src/providers` or the
  hooks changed. Fix its blocking findings.

## 5. Ship

- Commit in the worktree in the style `Add <feature>` (end with the Co-Authored-By line),
  then `git push -u origin <branch>`.
- `gh pr create` with a body that says what changed, how it was verified (paste the
  one-line verify summary) and `Closes #N`, and ends with the Claude Code attribution line.
- Label the issue `review` and remove `in-progress`. **Don't merge.** The owner merges.
- Leave the worktree with `ExitWorktree` (keep it, since the PR may need changes).

## 6. Discover (only when nothing is ready)

Look for real, specific work. File **at most 3** new issues per iteration, labelled
`triage` plus a priority and an area, each with the evidence (file:line, a command's output):

- failing or skipped tests, typecheck errors, or lint errors on `origin/main` (use a
  scratch worktree, not the main checkout)
- `TODO`, `FIXME` or "open for later" notes in PLAN.md and the README "Known limits"
  that have no issue yet
- gaps in the product promise ("fastest route, side streets included"): routing quality,
  request budget, the reroute engine
- missing tests for code in `src/core`

Before filing, search the existing issues (`gh issue list --search`) so you don't file duplicates.

You may promote a `triage` issue to `ready` yourself when it is small, has no open
question, and you can write concrete "Done when" criteria. Add them as a comment.

## 7. Report and pace

End the iteration with 3 to 6 lines: what you did (issue/PR links), what is blocked on the
owner (the `needs-human` list), and what comes next. Then pace yourself:
- if you shipped a PR and more `ready` work exists, schedule soon (60–300 s);
- if you are waiting on the owner (only `needs-human`/`review` left, nothing to discover),
  schedule 1800–3600 s;
- if CI or a PR check is running, schedule the time it usually takes.

## Hard limits

- Never push to `main`, never merge, never force-push, never close an issue without a merged PR.
- Never touch `.env.local` or tokens, or another session's uncommitted files.
- One issue per iteration. If a task would take more than about 400 changed lines, split
  it: file the parts as issues linked "Blocked by", and do only the first.
- No network calls from tests. Don't run `npm run build:signals` or `seed:charlotte`
  unless the issue asks for it.
