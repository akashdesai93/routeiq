// The owner's dashboard (Mission Control, `.claude/skills/orchestrate/SKILL.md` 4b) reads six
// JSON files in its own shapes. This turns a derived state (derive.mjs) into exactly those,
// so the orchestrator uploads state.mjs output instead of a hand-kept list. Pure.

export const DASHBOARD_FILES = ['sessions.json', 'prs.json', 'issues.json', 'events.json', 'decisions.json', 'health.json']

const SURFACE = { cloud: 'Cloud', local: 'Local' }

/** One dashboard session row. `status` is the parsed state, or `done` once the session has ended. */
export function dashboardSession(s) {
  const row = {
    id: s.id,
    name: s.name,
    kind: s.kind,
    surface: s.kind === 'agent' && s.surface === 'local' ? 'Local agent' : SURFACE[s.surface] || s.surface || '',
    where: s.where || '',
    branch: s.branch || '',
    role: s.role,
    working_on: s.working_on || '',
    issue: s.issue == null ? '' : String(s.issue),
    status: s.ended ? 'done' : s.status,
    last_seen: s.last_seen,
    group: s.group,
  }
  const waiting = s.ended ? null : s.blocked || (s.group === 'phone' ? 'the phone' : null)
  if (waiting) row.waiting_on = waiting
  if (s.link) row.link = s.link
  return row
}

/** The issue's stage from its state and labels, most specific first. */
export function issueStage(i) {
  if (i.state === 'closed') return 'done'
  for (const l of ['needs-human', 'blocked', 'in-progress', 'review', 'ready', 'triage']) if (i.labels.includes(l)) return l
  return 'open'
}

/** The option a recommendation picks: "(a) ..." names it by letter, or it starts with an option's words. */
export function recommendedOption(recommendation, options) {
  const r = String(recommendation || '').trim()
  if (!r || !options.length) return null
  const letter = /^\(?([a-z])\)/i.exec(r)?.[1]?.toLowerCase()
  if (letter) {
    const hit = options.find((o) => o.toLowerCase().startsWith(`(${letter})`))
    if (hit) return hit
  }
  const plain = (x) => x.replace(/^\([a-z]\)\s*/i, '').toLowerCase().trim()
  return options.find((o) => plain(o) && (plain(r).startsWith(plain(o)) || plain(o).startsWith(plain(r)))) || null
}

/** The one-row health table: main, the build last tried on the phone, the phone's state, the heartbeat, notes. */
export function dashboardHealth(state) {
  const h = state.health
  const tried = state.prs.filter((p) => p.phone_result).sort((a, b) => String(a.phone_result.at).localeCompare(String(b.phone_result.at))).pop()
  const phoneBuild = tried ? `PR #${tried.number} at ${tried.phone_result.sha.slice(0, 7)} (${tried.phone_result.result})` : ''
  const waiting = state.phoneQueue.length
  const phoneState = h.lab_window.open
    ? `lab window open until ${h.lab_window.until.slice(11, 16)} UTC`
    : waiting ? `${waiting} PR${waiting === 1 ? '' : 's'} waiting for the phone` : 'nothing waiting'
  const row = {
    main: h.main.state,
    phone_build: phoneBuild,
    phone_state: phoneState,
    heartbeat_at: h.heartbeat.orchestrator.at || '',
    notes: h.alerts.length ? h.alerts.map((a) => a.text).join('; ') : 'All clear.',
  }
  // The orchestrator knows what is really on the phone; its local file may say so.
  for (const k of Object.keys(row)) if (typeof state.local_health?.[k] === 'string') row[k] = state.local_health[k]
  return [row]
}

/** Exactly the dashboard's six files, by name. */
export function dashboardFiles(state) {
  const json = (x) => `${JSON.stringify(x, null, 2)}\n`
  const open = state.prs.map((p) => ({
    number: p.number,
    title: p.title,
    branch: p.branch,
    state: 'OPEN',
    opened: p.opened_at || '',
    merged: '',
    stage: p.stage,
    checks: p.checks,
    conflicting: p.conflicting,
    draft: p.draft,
    url: p.url,
  }))
  const merged = (state.merged || []).map((m) => ({ number: m.number, title: m.title, branch: m.branch, state: 'MERGED', opened: '', merged: m.merged_at, url: m.url }))
  const prs = [...open, ...merged].sort((a, b) => b.number - a.number)
  const issues = [...state.issues].sort((a, b) => b.number - a.number).map((i) => ({
    number: i.number,
    title: i.title,
    stage: issueStage(i),
    priority: i.priority || '',
    area: i.area[0] || '',
    updated: i.updated_at || '',
  }))
  const decisions = state.decisions.map((d) => ({
    issue: d.issue,
    question: d.question || d.title,
    recommendation: d.recommendation || '',
    options: d.options,
    recommended: recommendedOption(d.recommendation, d.options) || '',
  }))
  const events = [...state.events].reverse().map(({ at, who, kind, what }) => ({ at, who, kind, what }))
  return {
    'sessions.json': json(state.sessions.map(dashboardSession)),
    'prs.json': json(prs),
    'issues.json': json(issues),
    'events.json': json(events),
    'decisions.json': json(decisions),
    'health.json': json(dashboardHealth(state)),
  }
}
