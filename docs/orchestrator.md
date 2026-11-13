# How the RouteIQ fleet is run

Read this at the start of any session that coordinates, reviews, lands or builds. It is the
operating model: who does what, what the machine enforces, and what happens when something
breaks. CLAUDE.md has the coding rules; this file has the fleet rules.

The idea: **one orchestrator directs many sessions, and nothing depends on its memory.**
Everything a session needs to know is in GitHub (issues, labels, PRs, the status board #17)
and in this repo. Any fresh session can rebuild the whole picture with one command:

```bash
node scripts/orch/state.mjs --out tmp/orch     # sessions, PRs, issues, events, decisions, health
```

It writes `state.json` and, split out of it, `sessions.json`, `prs.json`, `issues.json`,
`events.json`, `decisions.json`, `health.json` and `phone-queue.json`, plus `board.md`,
`morning.md` and `alert.md`. With `--dashboard <dir>` it also writes the owner's dashboard
(Mission Control) files in the page's own shapes, exactly six: `sessions.json` (with `group`:
working, review, phone, blocked or done), `prs.json` (open and merged, with `stage`, `checks`,
`conflicting`), `issues.json` (with `stage`), `events.json`, `decisions.json` (with
`recommended`) and `health.json` (one row: `main`, `phone_build`, `phone_state`,
`heartbeat_at`, `notes`). The thresholds are in `scripts/orch/defaults.mjs`:

| Threshold | Default |
| --- | --- |
| #17 comments read (by last update) | 48 h |
| Orchestrator heartbeat stale (understudy acts) | 90 min |
| Heartbeat alert | 3 h |
| Session silent (working, waiting or blocked, with an open PR or a claimed issue) | 2 h |
| PR orphaned (red or conflicting, no push) | 2 h |
| Claim belongs to someone else | 2 h |
| Dispatched session that never posted | 1 h |

## Roles

Each role has a prompt template in `.claude/orch/roles/<role>.md`, rendered with
`node scripts/orch/prompt.mjs <role> --name <session> [--issues 84,85] [--note "..."]`.
The standing rules every role follows are in `.claude/orch/rules.md`, once.

| Role | Runs as | Started | Does | Never |
| --- | --- | --- | --- | --- |
| **orchestrator** | the local CLI session on the owner's PC, `/loop /orchestrate` | by the owner; any session can take over (below) | talks to the owner, dispatches sessions, runs the phone lab, does what cloud sessions cannot (below), posts the heartbeat | answers an owner decision itself; hand-edits the board |
| **understudy** | cloud routine, hourly | standing | nothing while the heartbeat is fresh; when it is stale, the reviewer's and conductor's duties and a board refresh | dispatches, touches the phone, answers or files owner decisions on its own, adds `phone-verified` |
| **reviewer** | cloud routine, hourly | standing | reviews each green PR with no verdict on its head commit, posts a verdict, **lands** approved PRs one at a time | reviews or lands its own PRs; lands on a red `required` |
| **conductor** | cloud routine, every 2 h | standing | keeps PRs landable: updates branches, resolves conflicts, fixes red CI on orphaned PRs, keeps `needs-phone` PRs current | lands PRs; changes what a PR does (only conflicts and CI fixes, each said in a comment) |
| **builder** | one-time cloud routine (or a local agent) | dispatched per issue | claims, builds, verifies, opens a PR, answers its review while it runs | merges; opens drafts; edits files of another open PR without saying so |
| **simplifier** | one-time cloud routine | dispatched when main is calm | behaviour-preserving cleanups, at most 2 open PRs, only in files no open PR touches | changes behaviour or thresholds |
| **design lead** | one-time cloud routine | dispatched per design run | UI work by the design tokens and `ux-review`, design guards in e2e | ships a look change without `needs-phone` |
| **phone lab** | local agent on the PC, phone on USB | by the orchestrator, inside a window the owner opened | works the phone queue, posts `phone-result:`, adds `phone-verified` on a pass | anything in "Phone lab hard rules" below |
| **phone-PR upkeep** | one-time cloud routine | before a phone window | makes every `needs-phone` PR conflict-free and green on current `main`, with a fresh build | changes a PR's code beyond conflicts |
| **findings** | one-time cloud routine | on demand (weekly, or when bot comments pile up) | sweeps Copilot and CodeQL comments across PRs; each true finding gets a fix and a guard | files a checklist line where an automated guard fits |

**One lander.** Only the reviewer lands PRs (and the orchestrator, or the understudy while
it acts). Last night the reviewer, the conductor and the orchestrator all merged, and each
merge made the others' PRs out of date. The conductor makes PRs landable; it does not land.

**Builders stop; their PRs don't become orphans.** A builder that ends posts `state: stopped`.
From then on its open PRs belong to the conductor, which `state.mjs` lists as `orphaned`
when they are red or conflicting with no push for 2 h. Standing roles are routines, so a
stopped one is restarted by its next firing; nobody has to notice.

## Labels

| Label | On | Means | Set by |
| --- | --- | --- | --- |
| `ready` | issue | can be picked up | orchestrator, work loop |
| `in-progress` | issue | claimed; with a `claude-loop: claimed by <session>` comment | the claimant |
| `blocked` | issue | held; with a `Held:` or `Blocked by #N` comment | anyone |
| `needs-human` | issue or PR | waiting on the owner; with one `Decision needed:` comment. **Fails `required` on a PR** | anyone; only the owner's answer removes it |
| `triage`, `review`, `p1`–`p3` (exactly one), `area:*` | issue | as before | anyone |
| `needs-phone` | PR | must be checked on the real iPhone. **Fails `required` until `phone-verified` is added** | the author or reviewer; also implied by a line of the PR body that starts with `PHONE CHECK NEEDED` |
| `phone-verified` | PR | the phone lab passed this PR | the phone lab or the owner only |
| `do-not-merge` | PR | not finished. **Fails `required`.** Use it instead of a draft | the author |
| `size-ok` | PR | passes the bundle growth limit (4 kB JS, 2 kB CSS per PR) and a change of `scripts/bundle-budget.json` (#170). **Without it those fail `required`** | the reviewer, with the reason in the verdict (an owner decision for the ceiling file) |
| `status-board` | #17 | the board | — |
| `orch-alert` | one issue | the fleet alert (below) | `board.yml` only |

**Proposed, not on (#203, waiting for the owner):** a `sim-verified` label that CI adds
itself when the iOS Simulator flows pass on a PR's head commit, and a narrower `needs-phone`
kept for the phone-only list in `docs/phone-lab.md` ("What needs the phone"). Until the owner
approves it, the labels and the gate are as in the table above.

## Formats

Everything below is parsed by `scripts/orch/state.mjs`. Lines it cannot parse still count as
"seen", but the board cannot say what the session is doing.

**Status comment on #17** (the `status` skill posts it):

```
status: <name> (<cloud|local>)
role: <role from the table>
state: <working | waiting | blocked | idle | stopped>
where: <branch>, PR #N            (or "no branch")
working on: #N <short title>      (or "idle")
done: <since the last status, with PR links, or "nothing yet">
next: <the next concrete step, or "none">
blocked: none                     (or what it waits for)
asks: none                        (or "orchestrator: <something only it can do>")
```

`waiting` means "on review, CI or the phone"; `stopped` means the session has ended. A session
that never said `stopped` has ended too once it has been quiet for the "session silent" time
with no open PR of its own and no issue it claimed: `state.mjs` marks it `ended` (dashboard
group `done`) and does not report it as silent. An optional `link: <url>` line gives the
dashboard a link for the session. A session
name is `cloud-<role>[-<issue or slug>]`, `local-<role>` or `agent-<slug>`, and stays the same
for the session's life. Free text may follow the block; it is not parsed.

**Dispatch comment on #17** (posted by whoever starts a session; `prompt.mjs --dispatch` prints it):

```
dispatch: <name> (<cloud|local>)
role: <role>
working on: #N, #M
by: <orchestrator session>
```

**Heartbeat** — one comment on #17 per writer, **edited in place** (never a new one):

```
heartbeat: orchestrator
session: <name>
state: active                     (or "away until <UTC time>": the understudy acts at once)
next tick: <minutes>
tick: <this tick's UTC time, e.g. 2026-11-12T14:05Z>
```

Its time is the later of the comment's `updated_at` and its `tick:` line (a tick ahead of the
present counts as now). Write the `tick:` line every time: GitHub leaves `updated_at` alone
when an edit does not change the body, so a tick that wrote the same four lines as the last
one was not a heartbeat. The orchestrator edits it every tick
(`node scripts/orch/state.mjs --print heartbeat-id` gives the comment id; create it if there is
none). The understudy keeps its own `heartbeat: understudy` comment, edited on ticks where it acts.

**Owner decision** — one comment on a `needs-human` issue, edited when the question changes:

```
Decision needed: <the question, one sentence>
Recommendation: <what and why, one line>
Options: (a) ... (b) ... (c) ...
```

A decision that lives only in a status comment or a PR body is not in the queue:
`state.mjs` lists it under `stray_decisions` and the orchestrator files it.

**Review verdict** — a comment on the PR: `verdict: approve <sha7>` or
`verdict: changes <sha7>`, then the findings with file:line.

**Phone result** — a comment on the PR: `phone-result: pass <sha7> · <scenarios> · <one line>`
or `phone-result: fail <sha7> · ...`. On a pass the lab adds `phone-verified`.

## Gates the machine enforces

A rule that only lives in a prompt failed last night. These are checked by workflows; branch
protection asks for the one check `required` (`docs/branch-protection.md`).

| Gate | Where | Fails when |
| --- | --- | --- |
| web, e2e, native, macOS builds | `gate.yml` | as before |
| skip-ci marker (#143) | `gate.yml` `merge-message` | the title or a commit carries `[skip ci]` or another skip marker |
| hold labels | `gate.yml` `required` (`scripts/orch/gates.mjs`) | the PR has `do-not-merge` or `needs-human` |
| phone | same | the PR has `needs-phone`, or a line of its body starts with `PHONE CHECK NEEDED`, and has no `phone-verified` |
| up to date by area | same | `main` changed an area this PR also changes (web app, iPhone shell, Swift core, native app, design, CI) after the PR's base: **update the branch** |
| bundle growth (#170) | same | the PR adds more than `growthPerPr` to the app JS or the CSS against the main it was tested on, the growth was not measured, or the PR changes `scripts/bundle-budget.json`; and it has no `size-ok`. (Above the owner's ceiling fails the `web` job itself; no label passes that) |
| re-check when things change | `gates.yml` | re-runs `required` of a PR when its labels or body change, and of every PR in an area `main` just changed |
| main red | `main-red.yml` | opens the `main is red` issue (p1) |
| fleet health | `board.yml` | opens the `orch-alert` issue (below) |

"Up to date by area" replaces `strict`, which is **off** on `main` (the docs said on). Strict
would make every PR update after every merge, docs included; the area rule only does that
where two changes can break each other (#91 and #121 were different files in one package).

## The board, the alert and the morning report

`.github/workflows/board.yml` runs hourly and on demand (`gh api -X POST
repos/akashdesai93/routeiq/actions/workflows/board.yml/dispatches -f ref=main`). It runs
`state.mjs`, rewrites the body of #17 (and nothing else there), uploads the JSON as the
`orch-state` artifact, and keeps one `orch-alert` issue open while health is bad:
orchestrator heartbeat older than 3 h, `main` red, `main` above 90 % of the bundle ceiling
(#170), orphaned PRs, sessions silent for 2 h with work in flight, stray decisions. It comments there only when the list changes, and
closes it when health is good. At its 11:23 UTC run it also posts the **morning report** on #17:
phone results first, then what needs the owner, in plain words.

Nobody edits the body of #17 by hand.

## Failure modes

| What happens | How it shows | What happens next |
| --- | --- | --- |
| The PC restarts; the orchestrator's loop dies | heartbeat age on the board; after 90 min the understudy acts; after 3 h the alert issue | the understudy keeps the cloud side moving; any fresh session can take over (below) |
| A builder stops with a PR open | `state: stopped`, or silent 2 h | the conductor adopts its PRs when they go red or conflict |
| A standing role's session ends | nothing to notice | the routine fires again within the hour |
| `main` goes red | `main is red` issue | the first session to claim that issue fixes it; the reviewer lands nothing until it is green |
| Two green PRs would break `main` together | the area gate makes the second update first | if something still slips through, `main-red.yml` |
| A PR needing the phone is approved | `required` stays red | it waits in the phone queue |
| An owner decision is raised in a status comment | `stray_decisions` in health, the alert issue | the orchestrator (or the understudy) files it as `needs-human` |
| The phone is locked or the lab is stuck | the lab posts `state: blocked` | it stays in the morning report until the owner acts |
| Actions is down or the board is stale | `_Updated_` line on #17 is old | tell the owner; nothing can merge anyway |
| Two sessions start fixing the same break | prevented by claim-before-fix (`rules.md`) | the second reviews the first's PR instead |

## Takeover (any fresh session, about 5 minutes)

1. Read CLAUDE.md and this file.
2. `node scripts/orch/state.mjs --out tmp/orch`, then read `tmp/orch/board.md` and
   `tmp/orch/health.json`.
3. If the orchestrator heartbeat is younger than 90 min, someone else is the orchestrator:
   stop here.
4. Edit the `heartbeat: orchestrator` comment with your session name
   (`--print heartbeat-id`; create it if missing). You are now the orchestrator.
5. Read what the understudy did meanwhile: `events.json` entries with `who` = `understudy`.
6. Check the standing routines below exist; create any that are missing (local only).
7. Read `decisions.json`; forward new ones to the owner.
8. Start `/loop /orchestrate`.

There is no private state to recover: if it matters, it is in an issue, a PR or this repo.

## Standing routines (the orchestrator creates these)

All on `akashdesai93/routeiq`, branch `main`, environment `routeiq`. The prompt is one line on
purpose: the real prompt lives in the repo, so a change is a PR, not a re-made routine.

| Name | Cron (UTC) | Prompt |
| --- | --- | --- |
| `routeiq-understudy` | `17 * * * *` | `Read CLAUDE.md and docs/orchestrator.md. Run node scripts/orch/prompt.mjs understudy --name cloud-understudy and follow what it prints.` |
| `routeiq-reviewer` | `5 * * * *` | `Read CLAUDE.md and docs/orchestrator.md. Run node scripts/orch/prompt.mjs reviewer --name cloud-reviewer and follow what it prints.` |
| `routeiq-conductor` | `40 */2 * * *` | `Read CLAUDE.md and docs/orchestrator.md. Run node scripts/orch/prompt.mjs conductor --name cloud-conductor and follow what it prints.` |

A tick that finds nothing to do posts nothing and ends, so an idle hour costs one short session
per routine. A tick that sees a `state: working` status of its own role younger than 60 min
ends too (the previous tick is still running).

## What only the orchestrator (or the owner) can do

Cloud sessions go through a GitHub proxy that has no GraphQL, and they cannot see the PC. When
a session needs one of these, it says so in `asks:` and moves on; it does not wait.

- GraphQL-only GitHub actions through `gh`: resolve a review thread, enable auto-merge, pin an
  issue. The GitHub MCP tools reach some of them from the cloud: `mcp__github__update_pull_request`
  with `draft: false` marked #162 ready (tried 2026-11-12). Try the MCP tool first; if it fails,
  ask. Still prefer `do-not-merge` to drafts: the gate enforces the label, and REST can remove it.
- Create, edit or delete routines; message a session.
- Anything on the phone or the PC.
- Repo settings, branch protection, secrets.
- Delete branches or tags (the proxy refuses).
- Read the code-scanning alerts API (403 in the cloud; read CodeQL through PR comments and check-run annotations).

## Phone lab hard rules

The lab is the only role that touches the phone. Details and the preflight are in
`docs/phone-lab.md`.

- Runs only inside a window the owner opened that night: a `lab-window: until <HH:MM> UTC`
  comment on #17, posted by the orchestrator when the owner says so.
  Never starts by itself when the phone gets unlocked: the owner may be picking it up to leave.
- No hardware buttons, no forced sleep. Location is only ever the simulated drive.
- Quiet hours 22:00–07:00 on the PC's clock: no scenario that speaks, unless the window says
  `· voice ok`. `run.mjs` enforces it.
- Tests only a build of the PR's current head commit; `preflight.mjs` refuses a stale one.
- A credential or trust prompt on the PC or the phone: stop, post `state: blocked`, never retry.
- The lab agent does not wake itself to poll; the queue script waits without a model, and
  `queue.mjs --wait-unlocked` needs `--until`, the end of the owner's window.

## What changed after the first night, and why

- Gates by label, not by reading paths or prose: the reviewer merged #158 although its body
  asked for a phone check.
- One lander instead of three.
- Standing roles are routines with one-line prompts that render from the repo, not long
  sessions that stop and must be noticed.
- The board, the Mission Control data and the alert come from `state.mjs`; no hand-kept ledger.
- Decisions go on issues: in the morning there were 0 `needs-human` issues although at least
  three decisions had been asked in status comments.
- Labels drift (a closed issue still `in-progress`, an issue with both `p2` and `p3`):
  `state.mjs` lists these under `label_drift`.
- `do-not-merge` instead of drafts: #143 sat as a draft because `gh` could not mark it ready
  (the MCP tool can, but the label is what the gate checks).
