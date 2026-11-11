---
name: verify
description: Run RouteIQ's full check (typecheck, lint, tests) and report pass/fail with the failures. Use before saying a change is done, before a commit, or when asked to check the build.
---

Run these from the repo root in Git Bash. Bare `npm` and `npx` are not on PATH there, so use the `.cmd` shims:

1. `npm.cmd run typecheck`: it must print no errors.
2. `npm.cmd run lint`: no errors allowed. Warnings are acceptable only if they were already
   there before your change. Compare with `git stash`-free reasoning: look at whether the
   warning's file and line are in your diff.
3. `rtk test npx.cmd vitest run`: every test must pass. If something fails, rerun just that
   file with `npx.cmd vitest run tests/<file>` to read the full error.

Report one line per check (pass/fail). For each failure, give the file:line and the cause.
Say whether the failure comes from your change or was already there (check it with `git diff`).
Don't call the work done while anything fails. Never "fix" a failing test by weakening
its assertion unless the behaviour change was intended. If it was, say so explicitly.
