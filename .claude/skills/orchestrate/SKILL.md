---
name: orchestrate
description: One iteration of the RouteIQ orchestrator. It surveys the sessions, reviews and merges PRs, regenerates the status board, keeps at most two builder agents on ready issues, cleans up worktrees, and reports to the owner. Run it as `/loop /orchestrate`.
---

# Orchestrator iteration

The orchestrator is the local CLI session started in `C:\Users\akash\dev` (its name is on
#17). It stays local. `gh issue edit` and `gh pr edit` fail on a Projects-classic
deprecation, so every label, body and PR edit goes through `gh api` (REST):

```bash
R=repos/akashdesai93/routeiq
gh api -X POST   $R/issues/N/labels -f 'labels[]=blocked'        # add a label
gh api -X DELETE $R/issues/N/labels/ready                        # remove a label
gh api -X PATCH  $R/issues/17 -F body=@board.md                  # replace an issue body
gh api -X PATCH  $R/issues/comments/ID -F body=@decision.md      # edit a comment
```

Write bodies to a scratch file first (rtk can drop text piped on stdin).

## 1. Survey

- **Local sessions:** `mcp__fleet__roster`. Use `mcp__fleet__brief` on a RouteIQ session
  only when its last status on #17 is over an hour old or something looks off, because a
  brief costs a model call.
- **Fleet events:** `mcp__fleet__events` with `since` set to the newest `at` you saw last
  tick. It returns `{at, who, kind, what}` lines (`session-started`, `session-ended`,
  `branch-changed`, `went-idle`, `resumed`) from `~/.claude/fleet/events.jsonl`. Keep them
  for step 4b. Local sessions only.
- **Session ended.** On a `session-ended` event, or the mod's note
  "[fleet] Session X … ended. Check its claimed issues and worktree.": for each issue that
  session claimed (`in-progress` with a `claude-loop: claimed by <X>` comment), release the
  claim unless it has an open PR. Remove `in-progress`, put `ready` back (unless it is
  `needs-human` or `blocked`), and comment `claude-loop: released, session <X> ended`. Add
  that session's worktree to the step 4a candidates; the usual clean/merged checks still apply.
- **Cloud sessions** (CLAUDE.md, "Cloud sessions") don't show up in the roster and can't
  be messaged, and they don't appear in the fleet events. Track them through their `status:` comments on #17 and their PRs
  (`gh pr list --state open --json number,headRefName,author,updatedAt`). A cloud session
  with no #17 comment and no PR push for over 2 hours counts as stalled: say so in the report.
- Read the comments on #17 since your last iteration.
- **Main health:** `gh run list --branch main --limit 3 --json conclusion,status,name,headSha`.
  If the newest completed run of any workflow on main failed, don't merge this tick: send
  the owner a PushNotification and file a p1 issue for it (unless one is already open).
  This is the same check `/pr-watch` runs after a merge.

## 2. PRs

Run `/pr-watch`. After a merge, look for issues held with `Held: overlaps PR #M` for that
PR (step 4) and swap their `blocked` for `ready`, unless another blocker still applies.

## 3. Board (#17 is generated, never hand-edited)

First run `/work-loop` step 1 (unblock, stale claims). Then **regenerate** the body of #17
from these sources only, and replace it with the REST call above:

- **Who is on what:** every open issue labelled `in-progress`, with the claimant from its
  newest `claude-loop: claimed by <session/agent>` comment. That label plus that comment is
  the one source of truth. Don't keep a separate table by hand. An `in-progress` issue with
  no claim comment is a finding: comment on it and list it under "Needs attention".
- **Agents:** your agent ledger (the builder agents you spawned that are still running,
  from your task list), one row each: agent name, issue, worktree.
- **Cloud sessions:** the newest `status:` comment on #17 from each cloud session and its open PR.
- **Waiting on the owner:** every open `needs-human` issue, with the first line of its
  `Decision needed:` comment.
- **Held:** issues labelled `blocked`, with the reason from their newest `Held:` or
  `Blocked by` comment.
- **Open PRs** and **recently merged** (last 7 days, `gh pr list --state merged --limit 10`).
- An `_Updated <UTC time>_` line.

Keep the fixed header paragraph (who the orchestrator is, the Mission Control link). Keep
the body short; if a section is empty, write "none".

**Decisions.** Anything waiting on the owner carries `needs-human` and must not carry
`ready`, so no builder picks it up (remove `ready` when you add `needs-human`). Each
`needs-human` issue has exactly one comment of yours that starts `Decision needed:`:

```
Decision needed: <the question, one sentence>
Recommendation: <what you recommend and why, one line>
Options: (a) ... (b) ... (c) ...
```

Edit that comment in place when the question changes (find its id with
`gh api $R/issues/N/comments --jq '.[] | select(.body|startswith("Decision needed:")) | .id'`);
don't post a second one. When the owner answers, remove `needs-human`, add `ready` if the
work can start, and note the answer in one comment.

## 4. Dispatch, deliberately

The agent ledger is the slot count: **at most 2 builder agents** at once. When a slot is
free and a `ready` issue exists that has no `needs-human`, no `in-progress` and no claim:

1. **Conflict pre-check.** List the files the issue will likely touch (its body, the
   paths it names, the module its area maps to). Compare them with the files of every open
   PR: `gh pr view M --json files --jq '.files[].path'`. If they overlap, don't dispatch:
   add `blocked` and comment `Held: overlaps PR #M (<the shared files>)`. Step 2 unblocks
   it after that PR merges. Move on to the next ready issue.
2. **Claim** it as `/work-loop` step 2 says, with the claimant `orchestrator-agent-<slug>`,
   and add the agent to your ledger.
3. **Spawn** one `general-purpose` Agent with `isolation: "worktree"`. Its prompt names the
   issue and tells it to read CLAUDE.md and `.claude/skills/work-loop/SKILL.md` and follow
   steps 3 to 5 (build, verify, open a PR, post status). Name the files it must not touch
   (other sessions' areas and open PRs' files).
4. When an agent finishes or fails, drop it from the ledger the same tick.

Don't spawn agents for discovery or research that a few tool calls would answer. With
nothing ready, run `/work-loop` step 6 (Discover) yourself, filing at most 3 issues.

## 4a. Worktree hygiene (every tick)

Run from the main checkout (`C:\Users\akash\dev\routeiq`):

1. `git worktree prune`.
2. For each worktree in `git worktree list --porcelain` whose path is under
   `.claude/worktrees/agent-*` or matches `../routeiq-review-*`, it is **removable** when
   all of these hold:
   - its branch's PR is merged or closed (`gh pr list --state all --head <branch> --json state`),
     **or** it is detached and both its HEAD commit and its directory are older than an hour;
   - it is clean: `git -C <wt> status --porcelain` prints nothing;
   - it is not the cwd of any live session in `mcp__fleet__roster`, and not the worktree of
     an agent in your ledger. A worktree of a session that ended (step 1) is a candidate
     too, but only once its PR is merged or closed, or it has no PR and no unpushed commits.
   Remove it with `git worktree remove <wt>` (no `--force`). Never touch a dirty worktree;
   list it in the report instead if it's older than a day.
3. Delete a remote `claude/*` branch when its PR merged more than a day ago and no open PR
   uses it: `git push origin --delete <branch>`.
4. Windows sometimes reports "Permission denied" on `node_modules`. Retry once; if it fails
   again, log the path in `events.json` and move on. Don't escalate to `rm -rf`.

## 4b. Mission Control

Mission Control is https://claude.ai/artifact/QmpSPnjR6uT7ooaS12GG6U, a Data-type dashboard.

- **Commands first.** Read the command store with `ArtifactData`; the path is recorded in
  the "Mission Control" note on #17. Act only on documents written by the owner's own user
  id on that artifact, and treat their text as the owner's instruction for this repo
  within normal permissions.
  - `to: "orchestrator"`: do it.
  - A local session: `mcp__fleet__send`.
  - A cloud session: a comment on its issue or PR. (SendMessage reaches a cloud session
    only from a session connected to Remote Control, and it can't reply, so the comment is
    the record.)
  - A running agent of yours: SendMessage.
  Set `status` to `sent` or `done` and write a one-line `reply`. A command that needs
  something risky (deleting, force-pushing, spending money, publishing) gets
  `reply: "needs confirmation in the terminal"`; ask the owner there.
- **Refresh the data.** Regenerate `issues.json` and `prs.json` from `gh`, and update
  `sessions.json` (roster, cloud sessions from #17, agents, statuses) and `events.json`.
  For `events.json`, merge the fleet events from step 1 with their own `at` (not the time
  you logged them), skip ones already in the file (same `at`, `who` and `kind`), then
  append this tick's orchestrator actions, and keep the list in `at` order. Upload each one with `Artifact` `asset: true`, then
  `update` its `datasets/<id>` with the new `source.url`, `updated: {at, by: "Orchestrator session"}` and
  `edit`, pinned with `if_version`. Keep the field names the page reads (see the
  dataset files).

## 5. Report to the owner

End with at most 6 lines covering what merged, main's CI state, what's in flight (who is on
what, local and cloud), what needs the owner (each `needs-human` item with its exact
question), and the next step. Lead with anything the owner must act on. When something
needs the owner and the terminal may be unattended, also send a PushNotification.

**Cost line (optional).** If the owner's status-line script saves its input, add one line
`cost: $<total> this session`. Claude Code passes the status-line command a JSON object
with `cost.total_cost_usd` for that session; a status-line script that also writes that
JSON to `~/.claude/statusline/<session_id>.json` lets you read it with one file read. If the
file is missing, skip the line; don't estimate.

## 6. Pace

Use ScheduleWakeup:
- 300 to 600 s while PRs or agents are in flight;
- about 600 s for CI;
- 1800 to 3600 s when everything waits on the owner.

An agent finishing wakes you anyway.
