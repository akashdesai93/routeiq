// Turns a raw GitHub snapshot (github.mjs collect) into the fleet's state: sessions, PRs,
// issues, events, decisions, health and the phone queue (docs/orchestrator.md). Pure: the
// snapshot and the time come in, so the same input always gives the same output.
import { DEFAULT_ORCH_OPTIONS } from './defaults.mjs'
import { numbersIn, parseDecision, parseDispatch, parseHeartbeat, parseLabWindow, parsePrComment, parseStatus } from './lib/status.mjs'

const HOLD_LABELS = ['do-not-merge', 'needs-human']
const WORKFLOW_LABELS = ['ready', 'in-progress', 'review', 'blocked']
// The marker counts at the start of a line (as PRs write it), not quoted inside a sentence or a table.
const PHONE_MARKER = /^[ \t>]*(?:\*\*|#+[ \t]*)?PHONE CHECK NEEDED\b/im

const hoursBetween = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 3600e3
const round1 = (x) => Math.round(x * 10) / 10
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const byAt = (a, b) => String(a.at).localeCompare(String(b.at))

// A session in one of these states that has gone silent with no work of its own has ended.
const LIVE_STATES = ['working', 'waiting', 'blocked', 'idle']
const CHECKS = { success: 'green', failure: 'red', pending: 'pending', missing: 'pending' }

/** Where an open PR is: blocked (on the owner), building (unfinished), phone, fixing (red or conflicting) or review. */
export function prStage({ labels, draft, needsPhone: phone, required, conflicting }) {
  if (labels.includes('needs-human')) return 'blocked'
  if (draft || labels.includes('do-not-merge')) return 'building'
  if (phone && !labels.includes('phone-verified')) return 'phone'
  if (required === 'failure' || conflicting) return 'fixing'
  return 'review'
}

/** The dashboard's group of a session: done, phone, blocked, review or working, from its state and its open PRs. */
export function sessionGroup(s, openPrs) {
  if (s.ended) return 'done'
  const stages = openPrs.filter(Boolean).map((p) => p.stage)
  if (s.role === 'phone lab' || stages.includes('phone')) return 'phone'
  if (s.status === 'blocked' || stages.includes('blocked')) return 'blocked'
  if (stages.length && stages.every((x) => x === 'review')) return 'review'
  return 'working'
}

export function needsPhone(pr) {
  return pr.labels.includes('needs-phone') || PHONE_MARKER.test(pr.body || '')
}

/** The steps under a "## Phone check" heading of a PR body, or the paragraph around the marker. */
export function phoneCheckSteps(body) {
  const lines = String(body || '').split(/\r?\n/)
  const start = lines.findIndex((l) => /^#{2,3}\s*Phone check\b/i.test(l))
  if (start >= 0) {
    const steps = []
    for (const l of lines.slice(start + 1)) {
      if (/^#{1,3}\s/.test(l)) break
      if (l.trim()) steps.push(l.trim())
    }
    if (steps.length) return steps
  }
  const para = String(body || '').split(/\n\s*\n/).find((x) => PHONE_MARKER.test(x))
  return para ? [para.trim().replace(/\s+/g, ' ')] : []
}

function requiredState(req) {
  if (!req) return 'missing'
  if (req.status !== 'completed') return 'pending'
  return req.conclusion === 'success' ? 'success' : 'failure'
}

/** @param raw the collect() snapshot. @param opts.now ISO time (defaults to raw.fetched_at). */
export function derive(raw, opts = {}) {
  const o = { ...DEFAULT_ORCH_OPTIONS, ...opts }
  const now = o.now || raw.fetched_at
  const nowMs = new Date(now).getTime()
  const seen = (c) => new Date(c.created_at).getTime() <= nowMs
  const comments = raw.board_comments.filter(seen).sort((a, b) => a.created_at.localeCompare(b.created_at))

  // --- sessions, from status and dispatch comments; the newest status wins.
  const statuses = comments.map(parseStatus).filter(Boolean)
  const dispatches = comments.map(parseDispatch).filter(Boolean)
  // A heartbeat counts from its edit; a tick line ahead of the present (a skewed clock) counts as now.
  const heartbeats = raw.board_comments.map(parseHeartbeat).filter(Boolean)
    .filter((h) => new Date(h.edited_at).getTime() <= nowMs)
    .map((h) => (new Date(h.at).getTime() > nowMs ? { ...h, at: now } : h))
  const sessions = new Map()
  const firstSeen = new Map()
  for (const s of statuses) {
    if (!firstSeen.has(s.name)) firstSeen.set(s.name, s.at)
    sessions.set(s.name, s)
  }
  const sessionList = [...sessions.values()].map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    surface: s.surface,
    where: s.where,
    branch: s.branch,
    role: s.role,
    working_on: s.working_on,
    issue: s.issue,
    prs: s.prs,
    status: s.state,
    blocked: s.blocked,
    asks: s.asks,
    next: s.next,
    formatted: s.formatted,
    link: s.link,
    first_seen: firstSeen.get(s.name),
    last_seen: s.at,
    silent_h: round1(hoursBetween(s.at, now)),
    url: s.url,
  }))
  for (const d of dispatches) {
    if (sessions.has(d.name)) continue
    sessionList.push({
      id: d.name, name: d.name, kind: 'session', surface: d.surface, where: null, branch: null, role: d.role,
      working_on: d.issues.map((n) => `#${n}`).join(', ') || null, issue: d.issues[0] ?? null, prs: [],
      status: 'dispatched', blocked: null, asks: null, next: null, formatted: true, link: null,
      first_seen: d.at, last_seen: d.at, silent_h: round1(hoursBetween(d.at, now)), url: null,
    })
  }
  sessionList.sort((a, b) => b.last_seen.localeCompare(a.last_seen))

  // Which session a PR belongs to: the newest status naming it, else one on its branch.
  const prOwner = new Map()
  for (const s of statuses) for (const n of s.prs) prOwner.set(n, s.name)
  const branchOwner = new Map()
  for (const s of statuses) for (const b of s.branches) branchOwner.set(b, s.name)

  // --- PRs
  const prs = raw.pulls.map((p) => {
    const marks = p.comments.filter(seen).map(parsePrComment).filter(Boolean)
    const verdict = marks.filter((m) => m.type === 'verdict').pop() || null
    const phone = marks.filter((m) => m.type === 'phone-result').pop() || null
    const required = requiredState(p.required)
    const conflicting = p.mergeable_state === 'dirty' || p.mergeable === false
    const lastPush = p.head_committed_at || p.created_at
    const idle = round1(hoursBetween(lastPush, now))
    const author = prOwner.get(p.number) || branchOwner.get(p.head_ref) || null
    const authorSession = author ? sessions.get(author) : null
    return {
      number: p.number,
      title: p.title,
      branch: p.head_ref,
      base: p.base_ref,
      head_sha: p.head_sha,
      draft: p.draft,
      labels: p.labels,
      author,
      author_state: authorSession ? authorSession.state : null,
      required,
      required_url: p.required?.url || null,
      mergeable_state: p.mergeable_state,
      conflicting,
      last_push: lastPush,
      idle_h: idle,
      updated_at: p.updated_at,
      needs_phone: needsPhone(p),
      phone_verified: p.labels.includes('phone-verified'),
      held: HOLD_LABELS.filter((l) => p.labels.includes(l)),
      verdict: verdict && { verdict: verdict.verdict, sha: verdict.sha, at: verdict.at, current: p.head_sha.startsWith(verdict.sha) },
      phone_result: phone && { result: phone.result, sha: phone.sha, text: phone.text, at: phone.at, current: p.head_sha.startsWith(phone.sha) },
      orphaned: (required === 'failure' || conflicting) && idle >= o.prIdleHours,
      checks: CHECKS[required],
      stage: prStage({ labels: p.labels, draft: p.draft, needsPhone: needsPhone(p), required, conflicting }),
      opened_at: p.created_at,
      url: p.html_url,
      build: p.build || null,
      body: p.body,
    }
  }).sort((a, b) => a.number - b.number)

  // --- issues
  const issues = raw.issues.map((i) => {
    const cs = (raw.issue_comments[i.number] || []).filter(seen)
    let claim = null
    for (const c of cs) {
      const m = parsePrComment(c)
      if (m?.type === 'claim') claim = { who: m.who, at: m.at }
      if (m?.type === 'release') claim = null
    }
    const decisionComment = [...cs].reverse().find((c) => parseDecision(c.body))
    return {
      number: i.number,
      title: i.title,
      state: i.state,
      labels: i.labels,
      priority: i.labels.filter((l) => /^p[1-3]$/.test(l)).sort()[0] || null,
      area: i.labels.filter((l) => l.startsWith('area:')).map((l) => l.slice(5)),
      claimed_by: claim?.who || null,
      claimed_at: claim?.at || null,
      needs_human: i.labels.includes('needs-human'),
      decision: decisionComment ? { ...parseDecision(decisionComment.body), at: decisionComment.created_at, url: decisionComment.html_url } : null,
      closed_at: i.closed_at,
      updated_at: i.updated_at || null,
      url: i.html_url,
    }
  }).sort((a, b) => a.number - b.number)

  // --- decisions: the queue is needs-human issues with a Decision needed comment.
  const decisions = issues.filter((i) => i.state === 'open' && i.needs_human).map((i) => ({
    issue: i.number,
    title: i.title,
    question: i.decision?.question ?? null,
    recommendation: i.decision?.recommendation ?? null,
    options: i.decision?.options ?? [],
    asked_at: i.decision?.at ?? null,
    url: i.decision?.url || i.url,
  }))
  const queued = new Set(decisions.map((d) => d.issue))
  const openNumbers = new Set([...issues.filter((i) => i.state === 'open').map((i) => i.number), ...prs.map((p) => p.number)])

  // A decision asked only in a session's newest status is stray, if what it is about is still open.
  const stray = []
  const strayKeys = new Set()
  for (const s of sessions.values()) {
    const line = s.body.split('\n').find((l) => /decision needed/i.test(l) && !/decision needed\W*none\b/i.test(l))
    if (!line) continue
    const refs = [...new Set(numbersIn(line).length ? numbersIn(line) : numbersIn(s.body))]
    if (refs.some((n) => queued.has(n))) continue
    if (refs.length && !refs.some((n) => openNumbers.has(n))) continue
    const key = refs[0] ?? s.name
    if (strayKeys.has(key)) continue
    strayKeys.add(key)
    stray.push({ who: s.name, at: s.at, about: refs, text: clip(line.replace(/^[-*\s]*(blocked:)?\s*/i, ''), 240), url: s.url })
  }

  // --- events
  const events = []
  for (const s of statuses) {
    const kind = s.state === 'stopped' ? 'stopped' : s.state === 'blocked' ? 'blocked' : firstSeen.get(s.name) === s.at ? 'started' : /\bPR\s*#\d+|shipped|merged/i.test(s.done || '') ? 'shipped' : 'status'
    events.push({ at: s.at, who: s.name, kind, what: clip(kind === 'blocked' ? s.blocked : kind === 'shipped' ? s.done : s.working_on || s.done || s.next, o.textMax) })
  }
  for (const d of dispatches) events.push({ at: d.at, who: d.by || 'orchestrator', kind: 'dispatched', what: `${d.name} as ${d.role}${d.issues.length ? ` on ${d.issues.map((n) => `#${n}`).join(', ')}` : ''}` })
  for (const m of raw.merged.filter((x) => new Date(x.merged_at).getTime() <= nowMs)) events.push({ at: m.merged_at, who: 'github', kind: 'merged', what: clip(`#${m.number} ${m.title}`, o.textMax) })
  for (const h of heartbeats) events.push({ at: h.at, who: h.who, kind: 'heartbeat', what: `${h.session || '?'} ${h.state}` })
  events.sort(byAt)

  // --- health
  const hb = (who) => {
    const h = heartbeats.filter((x) => x.who === who).sort(byAt).pop()
    if (!h) return { at: null, age_min: null, session: null, state: 'missing', away_until: null, stale: true, comment_id: null }
    const age = Math.round(hoursBetween(h.at, now) * 60)
    const awayAhead = h.state === 'away' && !(new Date(h.away_until).getTime() <= nowMs)
    return { at: h.at, age_min: age, session: h.session, state: h.state, away_until: h.away_until, stale: age >= o.heartbeatStaleMin || h.state === 'away', alert: age >= o.heartbeatAlertMin && !awayAhead, comment_id: h.comment_id }
  }
  const heartbeat = { orchestrator: hb('orchestrator'), understudy: hb('understudy') }
  if (heartbeat.orchestrator.state === 'missing') heartbeat.orchestrator.alert = true

  const newest = raw.main?.newest_completed
  const main = !newest
    ? { state: 'unknown', sha: null, url: null, at: null }
    : { state: newest.conclusion === 'success' ? 'green' : 'red', conclusion: newest.conclusion, sha: newest.head_sha.slice(0, 7), url: newest.html_url, at: newest.created_at }

  const orphaned = prs.filter((p) => p.orphaned).map((p) => ({ pr: p.number, title: p.title, reason: p.conflicting ? 'conflicting' : 'red', idle_h: p.idle_h, author: p.author, author_state: p.author_state }))
  // Silent counts only with work in flight: an open PR of its own, or an open issue it works on.
  // in_flight (the board's Sessions table) also counts an open issue the session only names;
  // the work that keeps a session alive is an open PR of its own or an issue it has claimed.
  const openPrs = new Set(prs.map((p) => p.number))
  const openIssues = new Set(issues.filter((i) => i.state === 'open').map((i) => i.number))
  const prByNumber = new Map(prs.map((p) => [p.number, p]))
  for (const s of sessionList) {
    s.in_flight = s.prs.some((n) => openPrs.has(n)) || prs.some((p) => p.author === s.name) || (s.issue != null && openIssues.has(s.issue))
    s.open_prs = [...new Set([...s.prs.filter((n) => openPrs.has(n)), ...prs.filter((p) => p.author === s.name).map((p) => p.number)])].sort((a, b) => a - b)
    s.claimed = issues.filter((i) => i.state === 'open' && i.claimed_by === s.name).map((i) => i.number)
    s.has_work = s.open_prs.length > 0 || s.claimed.length > 0
    s.ended = s.status === 'stopped' || (LIVE_STATES.includes(s.status) && !s.has_work && hoursBetween(s.last_seen, now) >= o.sessionSilentHours)
    s.group = sessionGroup(s, s.open_prs.map((n) => prByNumber.get(n)))
  }
  const silent = sessionList
    .filter((s) => ['working', 'waiting', 'blocked'].includes(s.status) && !s.ended && s.silent_h >= o.sessionSilentHours)
    .map((s) => ({ name: s.name, role: s.role, status: s.status, last_seen: s.last_seen, silent_h: s.silent_h, working_on: clip(s.working_on, 80) }))
  const dispatchedSilent = sessionList.filter((s) => s.status === 'dispatched' && s.silent_h >= o.dispatchSilentHours).map((s) => ({ name: s.name, dispatched_at: s.first_seen, silent_h: s.silent_h }))

  const labelDrift = []
  for (const i of issues) {
    const p = i.labels.filter((l) => /^p[1-3]$/.test(l))
    if (p.length > 1) labelDrift.push({ issue: i.number, problem: `more than one priority (${p.join(', ')})` })
    if (i.state === 'closed') {
      const stale = i.labels.filter((l) => WORKFLOW_LABELS.includes(l))
      if (stale.length) labelDrift.push({ issue: i.number, problem: `closed but still ${stale.join(', ')}` })
      continue
    }
    if (i.labels.includes('in-progress') && !i.claimed_by) labelDrift.push({ issue: i.number, problem: 'in-progress with no claim comment' })
    if (i.needs_human && !i.decision) labelDrift.push({ issue: i.number, problem: 'needs-human with no "Decision needed:" comment' })
    if (i.needs_human && i.labels.includes('ready')) labelDrift.push({ issue: i.number, problem: 'needs-human and ready' })
    if (i.labels.includes('in-progress') && i.labels.includes('triage')) labelDrift.push({ issue: i.number, problem: 'in-progress and triage' })
  }

  const phoneQueue = prs.filter((p) => p.needs_phone && !p.phone_verified).map((p) => ({
    pr: p.number,
    title: p.title,
    branch: p.branch,
    head_sha: p.head_sha,
    required: p.required,
    conflicting: p.conflicting,
    ready: !p.conflicting && p.required !== 'failure',
    build: p.build,
    how: p.build ? 'ipa' : 'push-web',
    steps: phoneCheckSteps(p.body),
    last_result: p.phone_result,
    url: p.url,
  }))

  const windows = comments.map(parseLabWindow).filter(Boolean)
  const lw = windows.pop() || null
  const labWindow = lw ? { ...lw, open: nowMs < new Date(lw.until).getTime() } : { open: false, until: null, opened_at: null, comment_id: null }

  const asks = sessionList.filter((s) => s.asks && s.status !== 'stopped').map((s) => ({ who: s.name, at: s.last_seen, ask: s.asks }))

  const alerts = []
  if (heartbeat.orchestrator.alert) alerts.push({ key: 'heartbeat', text: heartbeat.orchestrator.at ? `Orchestrator heartbeat is ${Math.round(heartbeat.orchestrator.age_min / 6) / 10} h old` : 'No orchestrator heartbeat on #17' })
  if (main.state === 'red') alerts.push({ key: 'main', text: `main is red at ${main.sha} (${main.conclusion})` })
  for (const p of orphaned) alerts.push({ key: `orphan-${p.pr}`, text: `PR #${p.pr} is ${p.reason} with no push for ${p.idle_h} h` })
  for (const s of silent) alerts.push({ key: `silent-${s.name}`, text: `${s.name} (${s.role}) is ${s.status} and silent for ${s.silent_h} h` })
  for (const d of stray) alerts.push({ key: `stray-${d.about[0] ?? d.who}`, text: `Decision asked by ${d.who} is not on a needs-human issue${d.about.length ? ` (${d.about.map((n) => `#${n}`).join(', ')})` : ''}` })

  const health = {
    generated_at: now,
    ok: alerts.length === 0,
    main,
    heartbeat,
    orphaned_prs: orphaned,
    silent_sessions: silent,
    dispatched_silent: dispatchedSilent,
    phone_gated: phoneQueue.map((q) => q.pr),
    open_decisions: decisions.length,
    stray_decisions: stray,
    asks,
    label_drift: labelDrift,
    lab_window: labWindow,
    alerts,
  }

  const merged = raw.merged.filter((m) => new Date(m.merged_at).getTime() <= nowMs)
    .map((m) => ({ number: m.number, title: m.title, branch: m.head_ref, merged_at: m.merged_at, url: m.html_url }))
    .sort((a, b) => b.number - a.number)

  return { generated_at: now, repo: raw.repo, sessions: sessionList, prs: prs.map(({ body: _body, ...p }) => p), merged, issues, events, decisions, health, phoneQueue }
}

/**
 * Adds local-only facts (the fleet roster and events) in the same shapes, without duplicates,
 * and `health`: the dashboard health fields only the PC knows (phone_build, phone_state, notes).
 */
export function mergeLocal(state, local) {
  const sessions = new Map(state.sessions.map((s) => [s.id, s]))
  for (const s of local.sessions || []) {
    const had = sessions.get(s.id)
    if (!had || String(s.last_seen) > String(had.last_seen)) sessions.set(s.id, { ...had, ...s })
  }
  const key = (e) => `${e.at}|${e.who}|${e.kind}`
  const events = new Map(state.events.map((e) => [key(e), e]))
  for (const e of local.events || []) if (!events.has(key(e))) events.set(key(e), e)
  const localHealth = local.health && typeof local.health === 'object' ? { local_health: local.health } : {}
  return { ...state, ...localHealth, sessions: [...sessions.values()].sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen))), events: [...events.values()].sort(byAt) }
}
