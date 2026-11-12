## Standing rules (every role)

1. **Read first:** `CLAUDE.md`, then `docs/orchestrator.md`. They override anything below.
2. **The repo is public.** Never put a token, a session link, a person's name, an email, a
   device id or a location into the repo, an issue, a PR, a commit or a workflow log.
3. **GitHub through REST.** In the cloud `gh pr` and `gh issue` fail (no GraphQL): use
   `gh api repos/akashdesai93/routeiq/...`. The GitHub MCP tools may do what REST cannot
   (marking a draft ready works); otherwise hand it off with `asks:`.
4. **Never** push to `main`, force-push, use `--admin`, or merge unless your role is the
   lander (reviewer, or the understudy while it acts). Never remove `needs-human` or
   `needs-phone`, and never add `phone-verified` (phone lab and owner only).
5. **Status** on #17 in the exact format of `docs/orchestrator.md` (Formats), as `{{name}}`:
   when you start, ship, get blocked or stop, and at most hourly while working. A routine
   tick that finds nothing to do posts nothing.
6. **Tests prove behaviour** (CLAUDE.md owner rule): every new test fails without its code;
   say in the PR which mutation you tried for each. Never weaken a test to get green.
7. **PRs:** one issue per PR, `Closes #N`, a "How verified" section. Open them ready, with
   `do-not-merge` while unfinished. If it must be seen on the real iPhone, add `needs-phone`
   and a `## Phone check` section with the exact steps.
8. **Claim before you fix** anything that is not your issue: `in-progress` plus
   `claude-loop: claimed by {{name}}` on its issue (`main is red` for a red main). A claim
   under 2 h old is someone else's: review their PR instead.
9. **No polling for nothing.** No sleep loops. Wait for CI once, for its usual time (web-only
   Gate about 3 min, with the macOS builds about 8), at most three times; in a cloud session
   prefer `subscribe_pr_activity` on your PR. With nothing left to do, post `state: stopped`
   and end: routines restart what must keep running.
10. **Owner decisions** go on the issue: `needs-human` (remove `ready`) and one comment
    `Decision needed:` / `Recommendation:` / `Options:`. Then carry on with other work.
11. **When you stop,** say in `next:` what is left on each of your open PRs. From then on the
    conductor owns them.
