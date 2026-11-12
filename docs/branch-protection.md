# CI and branch protection

`main` is protected. Nothing is pushed to it directly, by anyone, the owner's token
included: every change is a pull request, and a pull request merges only when the single
status check **`required`** is green.

## The one required check

`.github/workflows/gate.yml` runs on every pull request and every push to `main`. Its last
job is named `required`, and that is the only check branch protection asks for.

| job in `gate.yml` | runs | what it does |
| --- | --- | --- |
| `web` (`ci.yml`) | always | typecheck, lint, unit tests (with the counted-work guards), production build, bundle-size budget, the iPhone shell's web side on Linux (its unit tests, the web app built into `www/` with no token and the bridge script, the Xcode project generated and patched, a token search), `npm audit` (warns only) |
| `e2e` (`e2e.yml`) | always | the end-to-end scenarios, dealt over eight runners (`e2e/shard.mjs`: each scenario in exactly one shard, weighted by their measured CI seconds in `e2e/durations.json`); fails when any shard fails |
| `e2e-report` (`e2e-report.yml`) | after `e2e`, also when it failed | merges the shards' reports into the one `e2e-report` artifact; evidence only, not part of `required` |
| `native-core` (`native-core.yml`) | when the Swift package, `native/scripts`, the signal tiles or `tests/fixtures` change | `swift build`, `swift test`, the packer's test |
| `native-app` (`native-app.yml`) | when the native app or what it bundles changes | unsigned `.ipa` on macOS (`RouteIQ-native-unsigned`) |
| `shell-ios` (`shell-ios.yml`) | pull requests: when `native/shell` or the web build files (`package*.json`, `vite.config.ts`, `tsconfig*.json`) change; pushes to `main`: also for `src`, `public`, `index.html` | unsigned `.ipa` on macOS (`RouteIQ-unsigned`); the newest green `main` run always has a current one |
| `required` | always (`if: always()`) | passes when every job that had to run succeeded; fails when one failed, was cancelled, or was skipped although it had to run. On a pull request it also holds the PR gates (`scripts/orch/gates.mjs`): it fails while the PR has `do-not-merge` or `needs-human`, while it has `needs-phone` (or a body line starting with `PHONE CHECK NEEDED`) without `phone-verified`, and while `main` has changed an area the PR changes since the `main` commit this run tested |
| `shell-unit` | every push to `main` | the shell's Node unit tests (`native/shell`, `npm test`) on Linux; on pull requests they run inside `shell-ios` |
| `merge-message` | every pull request | fails when the title or a commit carries a skip-ci marker, which the squash merge would copy to `main` (GitHub then starts no workflow for that commit) |

On a push to `main` the unit tests of every area run whatever the push touched (#140): two
pull requests that were each green can break `main` together, and the merge commit after
them need not touch the area they broke. So `native-core` and `shell-unit` run on every
push to `main`; only the macOS builds stay path-filtered there.

`gates.yml` keeps those PR gates current without re-running the whole Gate: when a PR gains or
loses one of those labels or its body is edited, and when a push to `main` changes an area an
open PR also changes, it re-runs only the `required` job of that PR's newest finished Gate run
(about 15 s). The areas, in which two changes can break each other: web app, iPhone shell
(`native/shell`), Swift core (`native/RouteIQCore`, `docs/contracts`), native app, design, CI.
README, PLAN, `docs/` and `.claude/` are in none, so a docs merge never makes a PR stale.

`main-red.yml` follows the Gate on `main`: when the newest finished run failed or was
cancelled it opens the issue **main is red** (label `p1`, link to the run), or comments on
it if it is already open, and it closes it when `main` is green again. It uses the
workflow's own token with `issues: write` and `actions: read` only.

The exact path lists are in `gate.yml` under `changes`. A change to `gate.yml` itself runs
everything. Each of the five workflows can also be started by hand
(`gh workflow run shell-ios.yml`), and none has triggers of its own, so a change runs once.

Why one workflow: a check that is required but filtered out by `paths` never reports, and
its pull request waits for ever. `required` always reports, and it knows which of the
other jobs had to run.

Not part of the gate: `codeql.yml` (code scanning, on pull requests, on `main` and weekly)
and `pages.yml` (deploys the site after each push to `main`, which now means after each merge).

## Bundle-size budget

`npm run build && npm run size` (`scripts/check-bundle-size.mjs`) fails when the app's own
JavaScript or the CSS is larger than the budget in `scripts/bundle-budget.json`, and prints
the sizes in the job summary. Mapbox GL JS is built into its own `mapbox-gl-*.js` chunk
(`vite.config.ts`) and is not budgeted. Sizes are bytes, minified, not compressed.

| | measured (2026-11-11) | budget (+10 %) |
| --- | ---: | ---: |
| App JavaScript, without Mapbox GL JS | 368,176 | 404,994 |
| CSS | 58,661 | 64,528 |

When a growth is wanted: `npm run build && npm run size -- --update`, commit the new
`bundle-budget.json`, and say why in the pull request.

## Protection on `main`

Applied with `bash scripts/apply-branch-protection.sh` (as the owner, once, after the pull
request with `gate.yml` is merged). The script sends this to
`PUT repos/akashdesai93/routeiq/branches/main/protection`:

```json
{
  "required_status_checks": {
    "strict": false,
    "checks": [{ "context": "required", "app_id": 15368 }]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
```

| setting | value | why |
| --- | --- | --- |
| required status check | `required`, reported by GitHub Actions (app 15368) | the gate above |
| strict | **off** | strict would make every PR update after every merge, docs included. Instead the PR gate "up to date by area" fails `required` only when `main` changed an area the PR also changes after its checks ran (#91 and #121 broke `main` as two green PRs in one package). This doc said `true` until 2026-11-12; the setting on GitHub was `false` |
| pull request required | yes, 0 approvals | a solo owner cannot approve their own pull request; the review is the orchestrator's independent agent |
| dismiss stale reviews | off | there are no approvals to dismiss |
| `enforce_admins` | on | the rule applies to the owner's token too: no direct pushes |
| linear history | on | squash merges only |
| force pushes, deletions | not allowed | |
| conversation resolution | required | a "changes requested" thread must be resolved before the merge |

And to `PATCH repos/akashdesai93/routeiq`: `allow_squash_merge: true`,
`allow_merge_commit: false`, `allow_rebase_merge: false`, `allow_auto_merge: true`,
`delete_branch_on_merge: true`.

### What this changes day to day

- **No direct pushes to `main`,** docs and skill edits included. Branch, open a pull
  request, and merge it with `gh pr merge N --squash --auto`: it merges by itself once
  `required` is green.
- **"update the branch"** (the area gate): after another pull request merges in the same area,
  bring the next one up to date (`gh pr update-branch N`, or in the cloud
  `gh api -X PUT repos/akashdesai93/routeiq/pulls/N/update-branch`); the gate runs again.
  Land one at a time.
- **The head branch is deleted** on GitHub when its pull request merges. Start the next
  piece of work from `origin/main`.
- **Never `--admin`.** With `enforce_admins` it would not work anyway.
- **To take protection off in an emergency** (owner only):
  `gh api -X DELETE repos/akashdesai93/routeiq/branches/main/protection`, then run the
  script again afterwards.

## Security features on the repository

Turned on through the API on 2026-11-11 (free for public repositories):

- Dependabot alerts: `gh api -X PUT repos/akashdesai93/routeiq/vulnerability-alerts`
- Secret scanning and push protection: `PATCH repos/akashdesai93/routeiq` with
  `security_and_analysis.secret_scanning` and `.secret_scanning_push_protection` set to `enabled`
- Dependabot version updates: `.github/dependabot.yml` (weekly, grouped; npm in `/`,
  `/native/shell` and `/design`, and the GitHub Actions pins)
- Code scanning: `.github/workflows/codeql.yml`
