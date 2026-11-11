---
name: status
description: Post this session's status to the RouteIQ fleet status board (pinned issue #17). Use it when you start an issue, ship a PR or commit, get blocked, finish, or stop, so every session and the owner see the same picture.
---

Post one comment on issue #17 with `gh issue comment 17 -R akashdesai93/routeiq --body-file <file>`
(write the body to a scratch file first, because rtk can drop text piped on stdin):

```
status: <first 8 chars of your session id> · <branch or worktree>
working on: #N <title>   (or "idle")
done: <what finished since your last status, with PR/commit links, or "nothing yet">
next: <the next concrete step>
blocked: <the exact question for the owner, or "none">
```

Rules:
- Post when you start work, ship something, get blocked or stop, and at least once an
  hour while you are working. Keep it to 5 lines with no narrative.
- Don't edit the issue body. The orchestrator owns it.
- A blocking question for the owner also goes on the issue it belongs to, with the
  `needs-human` label.
- When you finish an issue, the PR that closes it is the record. The status comment just links it.
