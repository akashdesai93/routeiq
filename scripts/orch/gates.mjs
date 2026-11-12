#!/usr/bin/env node
// The PR gates the machine enforces (docs/orchestrator.md, "Gates the machine enforces").
// They run inside the Gate's `required` job, so branch protection holds them, and
// .github/workflows/gates.yml re-runs that job when a PR's labels or body change, or when
// main moves on in an area the PR changes.
//
//   node scripts/orch/gates.mjs --pr N [--tested <sha>]   # evaluate PR N; exit 1 when a gate fails
//   node scripts/orch/gates.mjs --recheck-pr N            # re-run `required` of PR N's newest finished Gate run
//   node scripts/orch/gates.mjs --recheck-main --before <sha> --after <sha>
//                                                       # re-run `required` of open PRs in an area that push changed
//   add --dry-run to print instead of re-running
//
// "Up to date" compares main now with the main commit the PR's checks ran on: a pull_request
// run tests the merge of the PR into main, so --tested is that merge commit (GITHUB_SHA) and
// its first parent is the main it saw. Without it, the PR's own base is used.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const HOLD_LABELS = ['do-not-merge', 'needs-human']
export const PHONE_LABEL = 'needs-phone'
export const PHONE_VERIFIED = 'phone-verified'
// At the start of a line, as PRs write it; a PR that only quotes it (like this one's docs) is not held.
// A list item ("- ", "* ", "+ ", "1. ") counts too: a reviewer writes it as a bullet as often as a line.
export const PHONE_MARKER = /^[ \t>]*(?:(?:[-*+]|\d+\.)[ \t]+)?(?:\*\*|#+[ \t]*)?PHONE CHECK NEEDED\b/im
/** GitHub's compare API lists at most this many files. */
export const COMPARE_FILE_LIMIT = 300
/** How long a re-check waits for a Gate run still in progress before re-running its `required` (gates.yml gives the job 10 min). */
export const RERUN_WAIT = Object.freeze({ pollMs: 15_000, maxMs: 4 * 60_000 })
// Job states in which `required` has not read the gates yet.
const NOT_STARTED = new Set(['queued', 'waiting', 'pending', 'requested'])

// Areas in which two changes can break each other. A path may be in several. Paths in no
// area (README, PLAN, docs, skills) never make a PR stale; anything not listed is "web".
const AREA_RULES = [
  [/^native\/shell\//, ['native-shell']],
  [/^native\/RouteIQCore\//, ['native-core']],
  [/^native\/RouteIQ\//, ['native-app']],
  [/^native\/scripts\//, ['native-core', 'native-app']],
  [/^native\//, ['native-app']],
  [/^design\//, ['design']],
  [/^\.github\//, ['ci']],
  [/^docs\/contracts\//, ['web', 'native-core']],
  [/^public\/seed\/osm-signals\//, ['web', 'native-core', 'native-app']],
  [/^tests\/fixtures\//, ['web', 'native-core']],
  [/^(docs\/|\.claude\/)/, []],
  [/^[^/]+\.md$/, []],
  [/^(LICENSE|\.gitignore|\.gitattributes)$/, []],
  [/^(package\.json|package-lock\.json|vite\.config\.ts|tsconfig[^/]*\.json)$/, ['web', 'native-shell']],
]

/** The areas a path belongs to. */
export function areasOf(path) {
  for (const [re, areas] of AREA_RULES) if (re.test(path)) return areas
  return ['web']
}

const areaSet = (files) => new Set(files.flatMap(areasOf))

/**
 * Evaluates the gates. Pure.
 * pr: { labels: string[], body: string, files: string[] }
 * main: { aheadBy: number, files: string[] } — what main has that the PR's head has not
 * → { ok, failures: [{ gate, message }] }
 */
export function evaluate(pr, main) {
  const failures = []
  for (const l of HOLD_LABELS) if (pr.labels.includes(l)) failures.push({ gate: 'hold', message: `the PR has the label \`${l}\`; remove it when the PR may merge` })
  const askedForPhone = pr.labels.includes(PHONE_LABEL) || PHONE_MARKER.test(pr.body || '')
  if (askedForPhone && !pr.labels.includes(PHONE_VERIFIED)) {
    const why = pr.labels.includes(PHONE_LABEL) ? `the label \`${PHONE_LABEL}\`` : 'its body says PHONE CHECK NEEDED'
    failures.push({ gate: 'phone', message: `the PR must be checked on the iPhone (${why}); the phone lab adds \`${PHONE_VERIFIED}\` when it passed` })
  }
  if (main && main.aheadBy > 0) {
    const mine = areaSet(pr.files)
    if (mine.size > 0) {
      if (main.files.length >= COMPARE_FILE_LIMIT) {
        failures.push({ gate: 'up-to-date', message: `main is ${main.aheadBy} commits ahead with more changed files than the compare API lists; update the branch` })
      } else {
        const theirs = areaSet(main.files)
        const shared = [...mine].filter((a) => theirs.has(a)).sort()
        if (shared.length) {
          const examples = main.files.filter((f) => areasOf(f).some((a) => shared.includes(a))).slice(0, 3)
          failures.push({ gate: 'up-to-date', message: `main changed ${shared.join(', ')} since this branch's base (${examples.join(', ')}${examples.length < main.files.length ? ', …' : ''}); update the branch so the checks run on both` })
        }
      }
    }
  }
  return { ok: failures.length === 0, failures }
}

// ---- I/O (gh api, REST)

function gh(path, method = 'GET') {
  const out = execFileSync('gh', ['api', '-X', method, '-H', 'Accept: application/vnd.github+json', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return out.trim() ? JSON.parse(out) : null
}

function prFiles(R, n, call = gh) {
  const files = []
  for (let page = 1; page <= 30; page++) {
    const batch = call(`${R}/pulls/${n}/files?per_page=100&page=${page}`)
    files.push(...batch.map((f) => f.filename), ...batch.filter((f) => f.previous_filename).map((f) => f.previous_filename))
    if (batch.length < 100) break
  }
  return files
}

/** The main commit a check run saw: the first parent of the merge commit it tested. */
function testedBase(R, testedSha, headSha) {
  if (!testedSha || testedSha === headSha) return headSha
  const c = gh(`${R}/commits/${testedSha}`)
  return c.parents?.length === 2 ? c.parents[0].sha : headSha
}

function readPr(R, n, testedSha) {
  const p = gh(`${R}/pulls/${n}`)
  const base = testedBase(R, testedSha, p.head.sha)
  const cmp = gh(`${R}/compare/${base}...${p.base.ref}`)
  return {
    number: n,
    head_sha: p.head.sha,
    state: p.state,
    pr: { labels: p.labels.map((l) => l.name), body: p.body || '', files: prFiles(R, n) },
    main: { aheadBy: cmp.ahead_by, files: (cmp.files || []).map((f) => f.filename) },
  }
}

/**
 * Re-runs the `required` job of the newest Gate run of a commit. A run still in progress is
 * waited for and then re-run anyway: its `required` may already have read the gates (it
 * finishes before e2e-report), so a label added in that window would otherwise be dropped.
 * `gh` and `sleep` are passed in so the tests can drive it. Returns what it did.
 */
export async function rerunRequired(R, sha, { dry = false, why = '', gh: call = gh, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), wait = RERUN_WAIT, log = console.log } = {}) {
  const newest = () => (call(`${R}/actions/workflows/gate.yml/runs?head_sha=${sha}&event=pull_request&per_page=5`).workflow_runs || [])[0]
  let run = newest()
  if (!run) {
    log(`  no Gate run for ${sha.slice(0, 7)} yet: its required job will read the gates when it runs`)
    return 'no-run'
  }
  if (run.status !== 'completed') {
    // A required job that has not started reads the gates when it does: nothing to wait for (and
    // a Gate run with the macOS builds outlasts the wait, so waiting would only fail this check).
    const job = (call(`${R}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`).jobs || []).find((j) => j.name === 'required')
    if (!job || NOT_STARTED.has(job.status)) {
      log(`  Gate run ${run.id} is ${run.status} and its required job has not started: it will read the gates`)
      return 'pending'
    }
  }
  for (let waited = 0; run.status !== 'completed'; waited += wait.pollMs) {
    if (waited >= wait.maxMs) throw new Error(`Gate run ${run.id} still ${run.status} after ${Math.round(wait.maxMs / 1000)} s; re-run this check once it finishes`)
    log(`  Gate run ${run.id} is ${run.status}: waiting for it, then re-running required`)
    await sleep(wait.pollMs)
    run = newest()
  }
  const job = (call(`${R}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`).jobs || []).find((j) => j.name === 'required')
  if (!job) {
    log(`  Gate run ${run.id} has no required job`)
    return 'no-job'
  }
  log(`  ${dry ? 'dry run: would re-run' : 're-running'} required (job ${job.id}, run ${run.id}): ${why}`)
  if (!dry) call(`${R}/actions/jobs/${job.id}/rerun`, 'POST')
  return dry ? 'dry-run' : 'rerun'
}

/**
 * Re-checks the open PRs after a push to main. One PR's failure (a 404, a run that can no
 * longer be re-run) does not stop the others; the failures are returned, so the job goes red.
 */
export async function recheckMain(R, { pushed, pushedAt, dry = false, gh: call = gh, rerun = rerunRequired, log = console.log } = {}) {
  const errors = []
  const open = call(`${R}/pulls?state=open&base=main&per_page=100`)
  for (const p of open) {
    try {
      const files = prFiles(R, p.number, call)
      const hit = evaluate({ labels: [], body: '', files }, { aheadBy: 1, files: pushed }).failures.find((f) => f.gate === 'up-to-date')
      const check = (call(`${R}/commits/${p.head.sha}/check-runs?check_name=required&per_page=5`).check_runs || [])[0]
      log(`PR #${p.number}: ${hit ? 'shares an area with this push' : 'unaffected'}, required ${check ? check.conclusion || check.status : 'missing'}`)
      if (check && check.started_at > pushedAt) log('  its checks started after this push, so they saw it')
      // A required still running may have read main before this push: re-run it too.
      else if (hit && check && (check.conclusion === 'success' || check.status !== 'completed')) await rerun(R, p.head.sha, { dry, why: hit.message, gh: call, log })
    } catch (e) {
      log(`::error title=gates: PR #${p.number}::${e.message}`)
      errors.push({ pr: p.number, message: e.message })
    }
  }
  return errors
}

async function main() {
  const argv = process.argv.slice(2)
  const R = `repos/${process.env.GITHUB_REPOSITORY || 'akashdesai93/routeiq'}`
  const dry = argv.includes('--dry-run')
  const num = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? Number(argv[i + 1]) : null
  }

  const arg = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : null
  }
  if (num('--pr')) {
    const s = readPr(R, num('--pr'), arg('--tested'))
    const result = evaluate(s.pr, s.main)
    console.log(`PR #${s.number} at ${s.head_sha.slice(0, 7)}: ${result.ok ? 'all gates pass' : `${result.failures.length} gate(s) fail`}`)
    for (const f of result.failures) console.log(`::error title=gate: ${f.gate}::${f.message}`)
    process.exitCode = result.ok ? 0 : 1
    return
  }
  if (num('--recheck-pr')) {
    const s = readPr(R, num('--recheck-pr'))
    console.log(`PR #${s.number}: labels or body changed`)
    await rerunRequired(R, s.head_sha, { dry, why: 'labels or body changed' })
    return
  }
  if (argv.includes('--recheck-main')) {
    // Only what this push changed can have made a PR stale; the re-run decides exactly.
    const before = arg('--before')
    const after = arg('--after')
    if (!before || !after || /^0+$/.test(before)) return console.log('no previous main commit: nothing to re-check')
    const pushed = (gh(`${R}/compare/${before}...${after}`).files || []).map((f) => f.filename)
    const pushedAt = gh(`${R}/commits/${after}`).commit.committer.date
    const errors = await recheckMain(R, { pushed, pushedAt, dry })
    if (errors.length) process.exitCode = 1
    return
  }
  console.error('usage: gates.mjs --pr N | --recheck-pr N | --recheck-main [--dry-run]')
  process.exitCode = 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => {
  console.error(`::error title=gates::${e.message}`)
  process.exitCode = 1
})
