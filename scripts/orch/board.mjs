// Renders the fleet state (derive.mjs) as Markdown: the body of the status board #17, the
// morning report for the owner and the body of the alert issue. Pure.

const fmtTime = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'never')
const ago = (h) => (h == null ? '' : h < 1 ? `${Math.round(h * 60)} min ago` : `${Math.round(h * 10) / 10} h ago`)
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—'
const hoursSince = (iso, now) => (new Date(now).getTime() - new Date(iso).getTime()) / 3600e3
const prRef = (p) => `#${p.number}`

function heartbeatLine(h, now) {
  const o = h.orchestrator
  if (!o.at) return 'Orchestrator: **no heartbeat on this issue**. The understudy is acting.'
  const who = o.session ? `\`${o.session}\`` : 'unknown session'
  const state = o.state === 'away' ? `away until ${o.away_until}` : o.state
  const tail = o.stale ? ' **Stale: the understudy is acting.**' : ''
  return `Orchestrator: ${who}, ${state}, heartbeat ${ago(hoursSince(o.at, now))}.${tail}`
}

/** The body of #17. */
export function renderBoard(state) {
  const { health: h, sessions, prs, decisions, issues } = state
  const now = state.generated_at
  const out = []
  out.push('# Fleet status board')
  out.push('')
  out.push('Written by `.github/workflows/board.yml` from `scripts/orch/state.mjs`; do not edit this body. Sessions post their status as comments here (format: `docs/orchestrator.md`, Formats).')
  out.push('')
  out.push(`_Updated ${fmtTime(now)}_ · main **${h.main.state}**${h.main.sha ? ` at \`${h.main.sha}\`` : ''} · ${heartbeatLine(h.heartbeat, now)}`)
  out.push('')

  out.push('## Needs the owner')
  if (!decisions.length && !h.stray_decisions.length) out.push('none')
  for (const d of decisions) out.push(`- #${d.issue} ${d.question ? cell(d.question) : `**${cell(d.title)}** (no "Decision needed:" comment yet)`}${d.recommendation ? ` Recommended: ${cell(d.recommendation)}` : ''}`)
  for (const d of h.stray_decisions) out.push(`- Not filed yet, asked by \`${d.who}\`: ${cell(d.text)}`)
  out.push('')

  out.push('## Alerts')
  out.push(h.alerts.length ? h.alerts.map((a) => `- ${a.text}`).join('\n') : 'none')
  out.push('')

  const active = sessions.filter((s) => s.status !== 'stopped' && (hoursSince(s.last_seen, now) < 12 || s.in_flight))
  out.push('## Sessions')
  if (!active.length) out.push('none')
  else {
    out.push('| Session | Role | State | Working on | PR | Last seen |')
    out.push('| --- | --- | --- | --- | --- | --- |')
    for (const s of active) out.push(`| \`${s.name}\` (${s.surface}) | ${s.role} | ${s.status}${s.blocked ? `: ${cell(s.blocked).slice(0, 60)}` : ''} | ${cell(s.working_on).slice(0, 70)} | ${s.prs.map((n) => `#${n}`).join(' ') || '—'} | ${ago(s.silent_h)} |`)
  }
  out.push('')

  out.push('## Open PRs')
  if (!prs.length) out.push('none')
  else {
    out.push('| PR | required | Gates | Verdict | Author | Last push |')
    out.push('| --- | --- | --- | --- | --- | --- |')
    for (const p of prs) {
      const gates = [p.conflicting ? 'conflicts' : null, ...p.held, p.needs_phone ? (p.phone_verified ? 'phone ✓' : 'needs phone') : null, p.orphaned ? '**orphaned**' : null].filter(Boolean).join(', ') || '—'
      const verdict = p.verdict ? `${p.verdict.verdict}${p.verdict.current ? '' : ' (older commit)'}` : '—'
      out.push(`| ${prRef(p)} ${cell(p.title).slice(0, 60)} | ${p.required} | ${gates} | ${verdict} | ${p.author ? `\`${p.author}\`` : '—'} | ${ago(p.idle_h)} |`)
    }
  }
  out.push('')

  out.push('## Phone queue')
  out.push(state.phoneQueue.length ? state.phoneQueue.map((q) => `- #${q.pr} ${cell(q.title)}: ${q.ready ? 'ready' : 'not ready'} (${q.how}${q.last_result ? `, last ${q.last_result.result}` : ''})`).join('\n') : 'none')
  out.push(`Lab window: ${h.lab_window.open ? `open until ${fmtTime(h.lab_window.until)}` : 'closed'}`)
  out.push('')

  const claimed = issues.filter((i) => i.state === 'open' && i.labels.includes('in-progress'))
  out.push('## Claimed issues')
  out.push(claimed.length ? claimed.map((i) => `- #${i.number} ${cell(i.title)}: ${i.claimed_by ? `\`${i.claimed_by}\`` : '**no claim comment**'}`).join('\n') : 'none')
  out.push('')

  const merged = state.events.filter((e) => e.kind === 'merged' && hoursSince(e.at, now) < 24)
  out.push(`## Merged in the last 24 h (${merged.length})`)
  out.push(merged.length ? merged.map((e) => e.what.split(' ')[0]).join(' · ') : 'none')
  if (h.label_drift.length) {
    out.push('')
    out.push('## Label drift')
    for (const d of h.label_drift) out.push(`- #${d.issue}: ${d.problem}`)
  }
  if (h.asks.length) {
    out.push('')
    out.push('## Asks for the orchestrator')
    for (const a of h.asks) out.push(`- \`${a.who}\`: ${cell(a.ask)}`)
  }
  out.push('')
  return out.join('\n')
}

/** The morning report: phone results first, then what needs the owner, in plain words. */
export function renderMorning(state, { sinceHours = 14 } = {}) {
  const now = state.generated_at
  const { health: h } = state
  const recent = (iso) => iso && hoursSince(iso, now) <= sinceHours
  const out = []
  out.push(`morning report · ${now.slice(0, 10)}`)
  out.push('')
  out.push('**On the phone**')
  const results = state.prs.filter((p) => p.phone_result && recent(p.phone_result.at))
  if (results.length) for (const p of results) out.push(`- #${p.number} ${p.title}: **${p.phone_result.result === 'pass' ? 'passed' : 'failed'}**${p.phone_result.text ? `, ${p.phone_result.text}` : ''}`)
  else out.push('- Nothing was tested on the phone overnight.')
  if (state.phoneQueue.length) out.push(`- Waiting for the phone: ${state.phoneQueue.map((q) => `#${q.pr}`).join(', ')}. ${h.lab_window.open ? '' : 'To run them, leave the phone plugged in and unlocked and tell the orchestrator until when.'}`.trim())
  out.push('')
  out.push('**Needs you**')
  if (!state.decisions.length && !h.stray_decisions.length) out.push('- Nothing.')
  for (const d of state.decisions) {
    out.push(`- #${d.issue}: ${d.question || d.title}`)
    if (d.recommendation) out.push(`  Recommended: ${d.recommendation}`)
    if (d.options.length) out.push(`  Options: ${d.options.join(' ')}`)
  }
  for (const d of h.stray_decisions) out.push(`- (not filed yet) ${d.text}`)
  out.push('')
  const merged = state.events.filter((e) => e.kind === 'merged' && recent(e.at))
  out.push('**Overnight**')
  out.push(`- ${merged.length} pull request${merged.length === 1 ? '' : 's'} merged. main is ${h.main.state}.`)
  if (h.orphaned_prs.length) out.push(`- Stuck: ${h.orphaned_prs.map((p) => `#${p.pr} (${p.reason})`).join(', ')}.`)
  if (h.heartbeat.orchestrator.stale) out.push(`- The orchestrator was away (heartbeat ${h.heartbeat.orchestrator.at ? fmtTime(h.heartbeat.orchestrator.at) : 'never'}); the understudy kept the cloud side going.`)
  out.push('')
  return out.join('\n')
}

/** The alert issue's body, and a stable key of what is wrong (to comment only on change). */
export function renderAlert(state) {
  const { health: h } = state
  const keys = h.alerts.map((a) => a.key).sort()
  const body = [
    'Opened and closed by `.github/workflows/board.yml` (`docs/orchestrator.md`). It is open while the fleet needs attention.',
    '',
    `_Checked ${fmtTime(state.generated_at)}_`,
    '',
    ...(h.alerts.length ? h.alerts.map((a) => `- ${a.text}`) : ['All clear.']),
    '',
    `<!-- alert-keys: ${keys.join(',')} -->`,
    '',
  ].join('\n')
  return { ok: h.alerts.length === 0, keys, body }
}
