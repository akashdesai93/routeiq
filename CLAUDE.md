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
npm.cmd run dev                # http://localhost:5173 (strictPort, localhost only)
```

To save tokens, wrap the test run with rtk: `rtk test npx.cmd vitest run`.
"Done" means typecheck, lint and tests are all green. The `/verify` skill runs all three.

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
8. **Licenses stay apart.** OSM data is ODbL. City of Charlotte data is CC BY-NC-SA. The
   two never share a file, a store or a module. They are merged only in memory, at the
   moment a route is counted.
9. **Privacy invariants** (README, Privacy): location is read only on an explicit action,
   never stored or logged, and never sent anywhere except to Mapbox as a route endpoint.
   Overpass sees tile bounding boxes only. Any new network call needs a Privacy note in the README.
10. **Secrets:** `.env.local` holds the Mapbox `pk.` token. Never read, print or commit it.
    The app refuses `sk.` tokens.

## How to build a step

1. Pick the next step in PLAN.md. If it's large, plan it first (plan mode) and agree on scope.
2. Put the logic in `src/core` with tests first. Scripted or fake-clock tests are better
   than mocks. No test hits the network.
3. Wire it up through a provider, a hook and a component.
4. Update the README (behaviour, thresholds table, privacy, data sources) and mark the
   step done in PLAN.md, along with its "Open for later" notes.
5. Run `/verify`, then commit one step per commit (message style: `Add <feature>`).

Before a commit with logic changes, run the `route-logic-reviewer` agent to check for invariant breaks.

## Task list and the autonomous loop

GitHub issues on `akashdesai93/routeiq` are the task list. The labels are `ready`,
`in-progress`, `blocked`, `needs-human`, `triage`, `review`, `p1`–`p3` and `area:*`.
`/loop /work-loop` runs autonomously. Each iteration syncs the board, claims the top
`ready` issue, builds it in its own worktree on `claude/issue-N-*`, verifies it and opens
a PR. When nothing is ready, it files new `triage` issues instead. Loops never push to
`main` and never merge: the owner merges PRs. Rules: `.claude/skills/work-loop/SKILL.md`.

## Where things stand (Nov 2026)

- Steps 1–8 are done and committed on `main`.
- **Uncommitted, in progress:** the live drive (real GPS). That is `core/live.ts`,
  `core/tracking.ts`, `core/guidance.ts`, `core/speechQueue.ts`, `src/live/runner.ts`,
  `src/device/{speech,visibility,wakeLock}.ts`, `useLiveDrive.ts`, `LiveDriveView.tsx`
  and `drive/replay.ts`. Ask before discarding or reshaping it.
- Other trees: `.claude/worktrees/native-app-3ae6fd` (branch `claude/native-app-3ae6fd`)
  and `../routeiq-probe` (branch `native-probe`, a Capacitor iOS background-location probe
  with a GitHub Actions macOS build). `../routeiq-design` is a separate design and slides kit.
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
