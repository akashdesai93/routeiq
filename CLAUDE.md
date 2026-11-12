# RouteIQ — notes for Claude

RouteIQ gets the driver there faster. It reads live traffic, considers every alternative
that could save time (side streets included), recommends the fastest and changes route
mid-drive when a faster one holds up. Today it is a Vite + React + TypeScript web
prototype (Charlotte / US-521 test corridor). Later it becomes a native iPhone + CarPlay
app built on the same pure logic.

- **README.md** covers behaviour, data sources, privacy and the exact rules (signal
  matching, ranking, rerouting thresholds). Read the relevant section before changing a rule.
- **PLAN.md** is the roadmap. Work happens one numbered step at a time.
- **docs/diagrams/** has the roadmap and architecture diagrams (HTML).

## Commands (Windows)

Git Bash cannot find bare `npm`/`npx`. Use the `.cmd` shims. In PowerShell, plain `npm` works.

```bash
npm.cmd run typecheck          # tsc -b (must be clean)
npm.cmd run lint               # oxlint (no new errors; existing react(refs) warnings are known)
npx.cmd vitest run             # all tests, offline, ~5 s
npx.cmd vitest run tests/reroute.test.ts   # one file
npm.cmd run build              # typecheck + vite build
npm.cmd run size               # bundle-size budget (after a build; scripts/bundle-budget.json)
npm.cmd run dev                # http://localhost:5173 (strictPort, localhost only)
npm.cmd run e2e                # end-to-end scenarios, offline, ~1 min (own ports per checkout)
npx.cmd playwright test e2e/drive.spec.ts -g "wrong turn"   # one scenario (after npm.cmd run e2e:build)
```

## Commands (Linux / cloud sessions)

In a Claude Code cloud session (or any Linux/macOS shell) the plain names work. The cloud
environment is prepared by `scripts/cloud-setup.sh` (see `docs/cloud-sessions.md`).

```bash
npm run typecheck              # tsc -b
npm run lint                   # oxlint
npx vitest run                 # all unit tests
npm run build                  # typecheck + vite build
npm run e2e                    # end-to-end scenarios (headless Chromium, offline)
npm run design:shots           # every screen at iPhone sizes into design-shots/ (skills: ux-review, design-tokens)
npx playwright test e2e/drive.spec.ts -g "wrong turn"   # one scenario (after npm run e2e:build)
(cd native/RouteIQCore && swift build --build-tests && swift test)   # native sessions only
node --test native/scripts/pack-signal-bundle.test.mjs              # native: signal bundle packer
```

To save tokens, wrap the test run with rtk: `rtk test npx.cmd vitest run`.
"Done" means typecheck, lint, unit tests and the e2e scenarios are all green, and a feature
the user can see or hear has an e2e scenario that shows it working. The `/verify` skill runs
typecheck, lint and unit tests; run `npm.cmd run e2e` as well. The report is
`e2e-report/index.html`: one page with each scenario's screenshots and what was said out loud.

## Architecture rules (do not break these)

1. **`src/core` is pure.** It may not use React, Mapbox, DOM, `window`, `document`,
   `fetch` or `localStorage`. `tests/core.test.ts` enforces this. Time, state and
   randomness come in as arguments, so the same inputs always give the same output. This is
   the part that gets ported to Swift, so keep it portable.
2. **Providers are adapter + client.** `adapter.ts` is a pure function from JSON to core
   types, with typed failures. `client.ts` does the I/O: it can be aborted, never
   rejects, and turns HTTP errors into readable messages. New data sources follow the
   same split, with hand-written fixtures in `tests/fixtures/`.
3. **Hooks and components orchestrate. They decide nothing.** Rules belong in `src/core`
   (reroute, rank, tracking, live, guidance). `src/map` only draws.
4. **Every threshold lives in one `DEFAULT_*` object** (`DEFAULT_REROUTE_OPTIONS`,
   `DEFAULT_SIGNAL_MATCH`, `DEFAULT_TRACKING_OPTIONS`, ...). No magic numbers inline.
   If you change a default, update the README table too.
5. **Unknown is never zero.** A partial or unknown signal count shows as
   "≥ N (partial)" or "unknown". It never shows as 0 and is never used for ranking.
   A missing typical duration stays `null` and is never guessed.
6. **Ranking is ETA first.** The signal count only breaks ties within 30 s. There is no
   per-signal penalty, because the traffic-aware ETA already includes the wait at signals.
7. **The reroute engine is conservative on purpose.** The minimum saving, the
   confirmation polls, the cooldown, no-return, lead distance and the freeway lead exist
   to stop flapping. Don't loosen them without a scripted test in `tests/reroute.test.ts`
   that shows why.
8. **Licenses stay apart.** OSM data is ODbL and is the only signal dataset (the City of
   Charlotte list was removed in #13). A new dataset under another license gets its own
   module, store and folder, and is merged with OSM only in memory, when a route is counted.
9. **Privacy invariants** (README, Privacy): location is read only on an explicit action,
   never stored or logged, and never sent anywhere except to Mapbox as a route endpoint.
   Overpass sees tile bounding boxes only. Any new network call needs a Privacy note in the README.
10. **Secrets:** `.env.local` holds the Mapbox `pk.` token. Never read, print or commit it.
    The app refuses `sk.` tokens.

## How to build a step

1. Pick the next step in PLAN.md. If it's large, plan it first (plan mode) and agree on scope.
2. Write the e2e scenario first, named as the behaviour in a sentence the owner would say
   ("when nothing is faster, it never switches"), in `e2e/*.spec.ts` with the harness in
   `e2e/harness.ts`. It runs the production build offline: Directions come from the made-up
   road network (`e2e/world/roads.ts`, traffic scripts in `e2e/world/traffic.ts`), search
   from `tests/fixtures`, GPS, voice and clock are stubbed. Take an `app.snap(...)` at each
   moment worth seeing. A request nothing answers fails the scenario.
3. Put the logic in `src/core`. Unit tests are for exact rules and thresholds (they are the
   spec for the Swift port: reroute, rank, signals, tracking, guidance, live, places,
   search, tiles, adapters). Don't add unit tests for wiring (hooks, components, "the panel
   shows X"): the e2e scenario covers that. No test hits the network, and fixtures use
   public landmarks only.
4. Wire it up through a provider, a hook and a component.
5. Update the README (behaviour, thresholds table, privacy, data sources) and mark the
   step done in PLAN.md, along with its "Open for later" notes.
6. Run `/verify` and `npm.cmd run e2e`, then commit one step per commit (message style: `Add <feature>`).

Before a commit with logic changes, run the `route-logic-reviewer` agent to check for invariant breaks.

## Tests must prove behaviour (owner rule)

No "green for the sake of green". A test exists to catch a real failure a driver would notice.

- **It must fail without the code.** Before you push, break or revert the logic it covers
  and watch the test go red. Say in the PR which mutation you tried for each new test.
- **Assert outcomes, not wiring.** Check what the user sees, hears or is charged for: the
  route chosen, the switch made or refused, the spoken line, the request count. Don't
  assert that a mock was called, that a component rendered "something", or a snapshot
  nobody reads.
- **Never weaken a test to make it pass.** No loosening an assertion, widening a tolerance,
  adding a retry, or adding `skip`/`only`/`todo` to get green. If a test is wrong, say why
  in the PR and replace it with one that checks the same behaviour.
- **A flaky test is a bug.** Find the race and fix it. Don't rerun until green.
- **Coverage counts are not a goal.** Ten tests that pin real rules beat fifty that restate
  the implementation.
- **Reviewers check this.** A PR whose tests wouldn't catch its own bug gets CHANGES.

## Task list and the autonomous loop

GitHub issues on `akashdesai93/routeiq` are the task list. The labels are `ready`,
`in-progress`, `blocked`, `needs-human`, `triage`, `review`, `p1`–`p3` and `area:*`.
`/loop /work-loop` runs autonomously. Each iteration syncs the board, claims the top
`ready` issue, builds it in its own worktree on `claude/issue-N-*`, verifies it and opens
a PR. When nothing is ready, it files new `triage` issues instead. Nobody pushes to
`main` (it is protected) and loops never merge their own PRs: the orchestrator reviews and merges (`/pr-watch`). Rules: `.claude/skills/work-loop/SKILL.md`.

## Coordination (several sessions at once)

- **Orchestrator:** the CLI session started in `C:\Users\akash\dev` (its name is on #17, currently `dev-18`). It keeps
  the board up to date, reviews and merges PRs (`/pr-watch`), sends out work, and reports
  to the owner. Other sessions don't merge.
- **Status board:** pinned issue #17. Every session posts with `/status` when it starts,
  ships, gets blocked or stops, and at least once an hour while working.
- **Check in on start (required, local sessions):** the first thing any session working on RouteIQ does is
  send the orchestrator a 5-line status (goal, branch/worktree, files you touch, done, next)
  with SendMessage. Find it in `ListAgents`: it's the CLI session whose cwd is
  `C:\Users\akash\dev`, and its current name is on #17. Message it again when you ship,
  get blocked or stop. The fleet mod also greets new RouteIQ sessions automatically.
- **Before editing:** run `mcp__fleet__roster` (the fleet mod) or `ListAgents` to see who
  else is in the repo, and `mcp__fleet__brief <id>` to read their context. Work in your
  own worktree. Never edit another session's uncommitted files.
- **`main` is protected: everything goes through a PR.** Nobody pushes to `main`, the
  owner's token and the orchestrator included, and that covers docs and skill edits too.
  A PR merges only when the single required check, **`required`**, is green. It is the last
  job of `.github/workflows/gate.yml`, which runs on every PR: the web checks (typecheck,
  lint, tests, build, bundle-size budget) and the e2e scenarios always, the Swift tests and
  the macOS builds when their paths change. The branch must also be up to date with `main`
  (`gh pr update-branch N`), and review threads must be resolved. Details and the exact
  settings: `docs/branch-protection.md`.
- **Ship work through PRs**, one issue per PR, with `Closes #N` and how it was verified.
  The orchestrator reviews the PR with an independent agent, then squash-merges it with
  `gh pr merge N --squash --auto`, which merges once `required` is green. GitHub deletes the
  head branch on merge. After a merge, restart from `origin/main`.
- **Questions for the owner** go on the issue with the `needs-human` label (remove `ready`)
  and in your status post, as one comment that starts `Decision needed:` with the question,
  a recommendation and the options. The orchestrator collects them for the owner.
- **Who is on what** is the `in-progress` label plus the comment
  `claude-loop: claimed by <session/agent>` on the issue. The orchestrator regenerates #17
  from those; nobody edits its body by hand.

### Cloud sessions

Some sessions run as Claude Code cloud sessions (claude.ai/code) instead of on the owner's
PC: the design session (#21), the native session (#15) and the e2e session (#32). Setup for
the owner: `docs/cloud-sessions.md`.

- **Start from the handoff.** Read this file, then the handoff comment on your issue, then continue.
- **No messaging.** A cloud session can't see or message the local sessions (the fleet mod,
  SendMessage and ListAgents are local only), so skip the check-in message and the roster.
  Report with `/status` comments on #17 instead, and through your PRs. The orchestrator
  reads both. Post a status when you start, ship, get blocked or stop, and at least once an
  hour while working.
- **`gh` is REST-only in the cloud.** `gh` is preinstalled and authenticated through the
  GitHub proxy, but the proxy rejects GraphQL, so `gh issue …` and `gh pr …` fail. Use `gh api`:

  ```bash
  R=repos/akashdesai93/routeiq
  gh api -X POST $R/issues/17/comments -F body=@status.md                 # status on #17
  gh api $R/issues/N/comments --jq '.[-5:][] | .body'                     # read a handoff
  gh api -X POST $R/pulls -f title="..." -f head=claude/... -f base=main -F body=@pr.md
  gh api -X POST $R/issues/N/labels -f 'labels[]=review'                  # labels
  gh api $R/actions/runs --jq '.workflow_runs[:5][] | [.name,.head_branch,.conclusion] | @tsv'
  ```
- **Same rules otherwise:** your own branch `claude/...` from `origin/main`, one issue per PR
  with `Closes #N` and how it was verified, never push to `main` (protected), never merge. Use the
  Linux commands above. Never paste or ask for the real Mapbox token; tests and the e2e
  build use a dummy `pk.test` token.
- The proxy pushes branches but refuses branch deletions and tags. The native session runs
  `bash scripts/cloud-setup.sh swift` once if `swift` is missing (see `docs/cloud-sessions.md`).

## Where things stand (Nov 2026)

- Steps 1–8 and the live drive (real GPS: `core/live.ts`, `core/tracking.ts`,
  `core/guidance.ts`, `src/live/runner.ts`, `useLiveDrive.ts`) are on `main` (`fa7e300`).
- The live board is pinned issue #17. This section is only a snapshot.
- Other trees: `.claude/worktrees/native-app-3ae6fd` (branch `claude/native-app-3ae6fd`)
  and `../routeiq-probe` (branch `native-probe`, a Capacitor iOS background-location probe
  with a GitHub Actions macOS build).
- UI design workspace: `design/` (moved in from the old local `../routeiq-design`). A separate
  Stageshow + Vite project with its own `package.json`, outside root typecheck, lint, tests
  and e2e. Run it with `cd design && npm install && npm run dev` (port 5273). Merged direction
  for #21/#22 is in `design/src/merged/` and `design/exports/merged/`; #47 is not done and
  `design/tools/patch47-draft.py` is an unapplied, untested draft. See `design/README.md`.
- Next in PLAN.md: step 9 (route hand-off to Google Maps / Waze), step 10 (freeze the
  contracts), step 11 (side-street alternatives, proposed).

## Gotchas

- Mapbox Directions returns **at most 3 routes**, so side streets that aren't among them
  are never seen. Step 11 in PLAN.md covers this. Don't assume the alternatives list is complete.
- Overpass is often busy (429/502). The bundled NC/SC tiles in `public/seed/osm-signals`
  are primary. Don't add code paths that hit Overpass for covered tiles.
- `npm run build:signals` rewrites about 900 files under `public/`. Stop the dev server first.
- The files have LF line endings while git warns about CRLF. That's harmless; don't reformat whole files.
- Search Box costs money per session (about 500 free a month). Keep the 350 ms debounce
  and the three-character minimum.
