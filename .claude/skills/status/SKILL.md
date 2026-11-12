---
name: status
description: Post this session's status to the RouteIQ fleet status board (pinned issue #17). Use it when you start an issue, ship a PR or commit, get blocked, finish, or stop, so every session and the owner see the same picture.
---

Post one comment on issue #17. Write the body to a scratch file first (rtk can drop text
piped on stdin), then post it with REST, which works locally and in the cloud:

```bash
gh api -X POST repos/akashdesai93/routeiq/issues/17/comments -F body=@<file>
```

The format is parsed by `scripts/orch/state.mjs`, which builds the board from it, so keep
the keys exactly (`docs/orchestrator.md`, Formats):

```
status: <name> (<cloud|local>)
role: <orchestrator | understudy | reviewer | conductor | builder | simplifier | design lead | phone lab | phone-PR upkeep | findings>
state: <working | waiting | blocked | idle | stopped>
where: <branch>, PR #N            (or "no branch")
working on: #N <short title>      (or "idle")
done: <what finished since your last status, with PR links, or "nothing yet">
next: <the next concrete step, or "none">
blocked: none                     (or what it waits for)
asks: none                        (or "orchestrator: <what only it can do>")
```

- `name` is the one you were dispatched with (`cloud-<role>[-<issue>]`, `local-<role>`,
  `agent-<slug>`); keep it for the session's life.
- `waiting` = on review, CI or the phone. `stopped` = you are ending; your open PRs then
  belong to the conductor, so say in `next:` what is left on them.
- Post when you start, ship, get blocked or stop, and at most once an hour while working.
  No narrative in the block; a table may follow it.
- An owner question never lives only here: put it on its issue with `needs-human` and a
  `Decision needed:` comment, and write `blocked: #N (needs-human)`.
- `asks:` is for what only the orchestrator can do (mark a draft ready, create a routine,
  delete a branch, the phone, repo settings). Post it and carry on; don't wait for it.
- Don't edit the issue body: `board.yml` writes it.
