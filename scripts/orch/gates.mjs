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
export const PHONE_MARKER = /PHONE CHECK NEEDED/i
/** GitHub's compare API lists at most this many files. */
export const COMPARE_FILE_LIMIT = 300

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

function prFiles(R, n) {
  const files = []
  for (let page = 1; page <= 30; page++) {
    const batch = gh(`${R}/pulls/${n}/files?per_page=100&page=${page}`)
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

/** Re-runs the `required` job of the newest finished Gate run of a commit. */
function rerunRequired(R, sha, dry, why) {
  const runs = (gh(`${R}/actions/workflows/gate.yml/runs?head_sha=${sha}&event=pull_request&per_page=5`).workflow_runs || [])
  const run = runs[0]
  if (!run) return console.log(`  no Gate run for ${sha.slice(0, 7)} yet: its required job will read the gates when it runs`)
  if (run.status !== 'completed') return console.log(`  Gate run ${run.id} is ${run.status}: its required job will read the gates when it gets there`)
  const job = (gh(`${R}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`).jobs || []).find((j) => j.name === 'required')
  if (!job) return console.log(`  Gate run ${run.id} has no required job`)
  console.log(`  ${dry ? 'dry run: would re-run' : 're-running'} required (job ${job.id}, run ${run.id}): ${why}`)
  if (!dry) gh(`${R}/actions/jobs/${job.id}/rerun`, 'POST')
}

function main() {
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
    rerunRequired(R, s.head_sha, dry, 'labels or body changed')
    return
  }
  if (argv.includes('--recheck-main')) {
    // Only what this push changed can have made a PR stale; the re-run decides exactly.
    const before = arg('--before')
    const after = arg('--after')
    if (!before || !after || /^0+$/.test(before)) return console.log('no previous main commit: nothing to re-check')
    const pushed = (gh(`${R}/compare/${before}...${after}`).files || []).map((f) => f.filename)
    const pushedAt = gh(`${R}/commits/${after}`).commit.committer.date
    const open = gh(`${R}/pulls?state=open&base=main&per_page=100`)
    for (const p of open) {
      const files = prFiles(R, p.number)
      const hit = evaluate({ labels: [], body: '', files }, { aheadBy: 1, files: pushed }).failures.find((f) => f.gate === 'up-to-date')
      const check = (gh(`${R}/commits/${p.head.sha}/check-runs?check_name=required&per_page=5`).check_runs || [])[0]
      console.log(`PR #${p.number}: ${hit ? 'shares an area with this push' : 'unaffected'}, required ${check ? check.conclusion || check.status : 'missing'}`)
      if (check && check.started_at > pushedAt) console.log('  its checks started after this push, so they saw it')
      else if (hit && check && check.conclusion === 'success') rerunRequired(R, p.head.sha, dry, hit.message)
    }
    return
  }
  console.error('usage: gates.mjs --pr N | --recheck-pr N | --recheck-main [--dry-run]')
  process.exitCode = 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
