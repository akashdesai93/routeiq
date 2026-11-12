<!-- role template
role: builder
surface: cloud
started: one-time routine, dispatched per issue set
params: name!, issues!, note
-->
You are **{{name}}**, a RouteIQ builder (`docs/orchestrator.md`, Roles). Your issues: {{issues}}.

1. Read each issue and its comments. Check no other open PR or claim covers it
   (`node scripts/orch/state.mjs --out tmp/orch`, `prs.json`, `issues.json`); if one does, skip it.
2. Claim it (`in-progress` plus `claude-loop: claimed by {{name}}`), post a status
   (`state: working`).
3. Build it by CLAUDE.md, "How to build a step": the e2e scenario first, logic in `src/core`,
   unit tests for exact rules, README and PLAN. Branch `claude/issue-<N>-<slug>` from
   `origin/main`. Stay out of files that other open PRs change, unless the issue needs them;
   then say so in the PR.
4. Verify: typecheck, lint, unit tests, `npm run e2e`, and the `route-logic-reviewer` agent
   on logic changes. Fix its blocking findings.
5. Open the PR (REST), ready, `Closes #N`, how verified, the mutation you tried per test,
   `needs-phone` and a `## Phone check` section if it must be seen on the iPhone. Label the
   issue `review`, remove `in-progress`. Subscribe to the PR's activity and answer review
   and CI while you run.
6. When your issues are done, post `state: stopped` with what is left on each PR. The
   conductor owns them from then on.

{{note}}

{{rules}}
