// Reads what state.mjs needs from GitHub, through `gh api` (REST only: it works in Actions,
// locally and through the cloud sessions' proxy, which has no GraphQL). This is the only
// file of scripts/orch that does I/O on the network; derive.mjs turns its result into state.
import { execFileSync } from 'node:child_process'

const PHONE_ARTIFACT = 'RouteIQ-unsigned'

function ghJson(path) {
  const out = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(out)
}

/** Every page of a list endpoint (per_page=100), up to `maxPages`. */
function ghList(path, maxPages = 10, pick = (x) => x) {
  const out = []
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const items = pick(ghJson(`${path}${sep}per_page=100&page=${page}`))
    out.push(...items)
    if (items.length < 100) break
  }
  return out
}

const slimComment = (c) => ({ id: c.id, created_at: c.created_at, updated_at: c.updated_at, body: c.body || '', html_url: c.html_url })
const labelNames = (labels) => (labels || []).map((l) => (typeof l === 'string' ? l : l.name))

/** Collects the raw snapshot. `log` gets one line per step (to stderr in the CLI). */
export function collect({ repo, board = 17, windowHours, now = new Date(), log = () => {} }) {
  const R = `repos/${repo}`
  const since = new Date(now.getTime() - windowHours * 3600e3).toISOString()

  log(`#${board} comments updated since ${since}`)
  const boardComments = ghList(`${R}/issues/${board}/comments?since=${since}`).map(slimComment)

  log('open issues and recently closed ones')
  const rawIssues = [
    ...ghList(`${R}/issues?state=open`),
    ...ghList(`${R}/issues?state=closed&since=${since}`, 3),
  ].filter((i) => !i.pull_request && i.number !== board)
  const issues = rawIssues.map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    labels: labelNames(i.labels),
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
    html_url: i.html_url,
  }))

  const watched = issues.filter((i) => i.state === 'open' && i.labels.some((l) => ['in-progress', 'needs-human', 'blocked'].includes(l)))
  log(`comments of ${watched.length} claimed, held or needs-human issues`)
  const issueComments = {}
  for (const i of watched) issueComments[i.number] = ghList(`${R}/issues/${i.number}/comments`, 3).map(slimComment)

  log('open pull requests')
  const pulls = []
  for (const p of ghList(`${R}/pulls?state=open`, 3)) {
    const full = ghJson(`${R}/pulls/${p.number}`)
    const commit = ghJson(`${R}/commits/${p.head.sha}`)
    const runs = ghJson(`${R}/commits/${p.head.sha}/check-runs?check_name=required&per_page=10`).check_runs || []
    const req = runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0] || null
    const labels = labelNames(p.labels)
    const pull = {
      number: p.number,
      title: p.title,
      body: p.body || '',
      draft: !!p.draft,
      head_ref: p.head.ref,
      head_sha: p.head.sha,
      base_ref: p.base.ref,
      labels,
      created_at: p.created_at,
      updated_at: p.updated_at,
      html_url: p.html_url,
      mergeable: full.mergeable,
      mergeable_state: full.mergeable_state,
      head_committed_at: commit.commit?.committer?.date || null,
      required: req && { status: req.status, conclusion: req.conclusion, started_at: req.started_at, completed_at: req.completed_at, url: req.html_url },
      comments: ghList(`${R}/issues/${p.number}/comments`, 3).map(slimComment),
      build: null,
    }
    if (labels.includes('needs-phone') || /PHONE CHECK NEEDED/i.test(pull.body)) pull.build = phoneBuild(R, p.head.sha)
    pulls.push(pull)
  }

  log('recently merged pull requests')
  const merged = ghJson(`${R}/pulls?state=closed&sort=updated&direction=desc&per_page=50`)
    .filter((p) => p.merged_at && p.merged_at >= since)
    .map((p) => ({ number: p.number, title: p.title, merged_at: p.merged_at, head_ref: p.head.ref, merge_commit_sha: p.merge_commit_sha, html_url: p.html_url }))

  log('Gate on main')
  const gateRuns = ghJson(`${R}/actions/workflows/gate.yml/runs?branch=main&event=push&per_page=5`).workflow_runs || []
  const slimRun = (r) => r && { id: r.id, status: r.status, conclusion: r.conclusion, head_sha: r.head_sha, created_at: r.created_at, html_url: r.html_url }
  const main = {
    newest: slimRun(gateRuns[0] || null),
    newest_completed: slimRun(gateRuns.find((r) => r.status === 'completed') || null),
  }

  return { repo, board, fetched_at: now.toISOString(), window_hours: windowHours, board_comments: boardComments, issues, issue_comments: issueComments, pulls, merged, main }
}

/** The newest successful Gate run of this commit that has the iPhone build, or null. */
function phoneBuild(R, sha) {
  const runs = (ghJson(`${R}/actions/runs?head_sha=${sha}&per_page=20`).workflow_runs || []).filter((r) => r.name === 'Gate' && r.conclusion === 'success')
  for (const run of runs) {
    const arts = ghJson(`${R}/actions/runs/${run.id}/artifacts?per_page=50`).artifacts || []
    if (arts.some((a) => a.name === PHONE_ARTIFACT && !a.expired)) return { run_id: run.id, artifact: PHONE_ARTIFACT, head_sha: sha }
  }
  return null
}
