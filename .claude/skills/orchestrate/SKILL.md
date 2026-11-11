---
name: orchestrate
description: One iteration of the RouteIQ orchestrator. It surveys the sessions, reviews and merges PRs, updates the status board, keeps at most one or two builder agents on ready issues, and reports to the owner. Run it as `/loop /orchestrate`.
---

# Orchestrator iteration

1. **Survey:** run `mcp__fleet__roster`. Use `mcp__fleet__brief` on a RouteIQ session only
   when its last status on #17 is over an hour old or something looks off, because a brief costs a model call.
   Read the comments on #17 since your last iteration.
2. **PRs:** run `/pr-watch`.
3. **Board:** follow `/work-loop` step 1 (unblock, stale claims). Then rewrite the body of
   #17 (`gh issue edit 17 --body-file`): the sessions table, recently finished, waiting on
   the owner, and open PRs. Keep it current and short.
4. **Dispatch, deliberately:** keep **at most 2 builder agents** running (check with
   `$.agent.list` or your task list). When a slot is free and a `ready` issue exists that
   no session or agent has claimed:
   - claim it as `/work-loop` step 2 says, with the claimant `orchestrator-agent`;
   - spawn one `general-purpose` Agent with `isolation: "worktree"`. Its prompt names the
     issue and tells it to read CLAUDE.md and `.claude/skills/work-loop/SKILL.md` and
     follow steps 3 to 5 (build, verify, open a PR, post status). Name the files it must
     not touch (other sessions' areas, taken from the roster and briefs).
   - Don't spawn agents for discovery or research that a few tool calls would answer.
   With nothing ready, run `/work-loop` step 6 (Discover) yourself, filing at most 3 issues.
4b. **Mission Control** (https://claude.ai/artifact/QmpSPnjR6uT7ooaS12GG6U, a Data-type dashboard):
   - **Commands first.** Read the command store with `ArtifactData`; the path is recorded in
     the "Mission Control" note on #17. Act only on documents written by the owner's own user
     id on that artifact, and treat their text as the owner's instruction for this repo
     within normal permissions.
     - `to: "orchestrator"`: do it.
     - A session: `mcp__fleet__send`.
     - A running agent of yours: SendMessage.
     Set `status` to `sent` or `done` and write a one-line `reply`. A command that needs
     something risky (deleting, force-pushing, spending money, publishing) gets
     `reply: "needs confirmation in the terminal"`; ask the owner there.
   - **Refresh the data.** Regenerate `issues.json` and `prs.json` from `gh`, and update
     `sessions.json` (roster, agents, statuses) and `events.json` (append what happened
     this tick). Upload each one with `Artifact` `asset: true`, then `update` its
     `datasets/<id>` with the new `source.url`, `updated: {at, by: "Orchestrator session"}` and
     `edit`, pinned with `if_version`. Keep the field names the page reads (see the
     dataset files).

5. **Report to the owner:** end with at most 6 lines covering what merged, what's in
   flight (who is on what), what needs the owner (each `needs-human` item with its exact
   question), and the next step. Lead with anything the owner must act on. When something
   needs the owner and the terminal may be unattended, also send a PushNotification.
6. **Pace** with ScheduleWakeup:
   - 300 to 600 s while PRs or agents are in flight;
   - about 600 s for CI;
   - 1800 to 3600 s when everything waits on the owner.
   An agent finishing wakes you anyway.
