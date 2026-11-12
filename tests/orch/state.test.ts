import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderAlert, renderBoard, renderMorning } from '../../scripts/orch/board.mjs'
import { derive, mergeLocal, type Json } from '../../scripts/orch/derive.mjs'
import { parseDecision, parseHeartbeat, parseLabWindow, parseStatus } from '../../scripts/orch/lib/status.mjs'
import { outputs } from '../../scripts/orch/state.mjs'

// The fleet's state from GitHub alone (docs/orchestrator.md). The fixture is the real board of
// the first night (#17, 2026-11-11 20:40 to 2026-11-12 11:33 UTC, links scrubbed), with the PRs,
// issues and main's Gate as they were at the end. What the owner needs from it: who is on
// what, what is stuck with nobody on it, and what waits for them, even from messy free text.

const night: Json = JSON.parse(readFileSync('tests/orch/night-2026-11-12.json', 'utf8'))
const at = (now?: string) => derive(night, now ? { now } : {})
const session = (state: Json, name: string) => state.sessions.find((s: Json) => s.name === name)

describe('sessions from last night\'s free-text statuses', () => {
  const end = at()

  it('reads the name, surface and branch from every first-line style', () => {
    expect(session(end, 'cloud-5')).toMatchObject({ surface: 'cloud', role: 'builder', status: 'stopped' })
    expect(session(end, 'cloud-74-68')).toMatchObject({ surface: 'cloud', branch: 'claude/reroute-74-68' })
    expect(session(end, 'agent-sim-drive')).toMatchObject({ surface: 'cloud', status: 'stopped' }) // "(cloud): shipped, stopping"
    expect(session(end, 'cloud-builder')).toMatchObject({ surface: 'cloud' }) // "**Status (cloud builder, overnight)**"
    expect(session(end, 'agent-gapfill')).toMatchObject({ surface: 'local', kind: 'agent', issue: 13 }) // "- Issue: #13 ..."
  })

  it('knows the standing roles from their names', () => {
    expect(session(end, 'cloud-reviewer')).toMatchObject({ role: 'reviewer', status: 'stopped' })
    expect(session(end, 'cloud-conductor')).toMatchObject({ role: 'conductor', status: 'stopped' })
    expect(session(end, 'cloud-phone-prs')).toMatchObject({ role: 'phone-PR upkeep' })
    expect(session(end, 'agent-phone-lab')).toMatchObject({ role: 'phone lab', status: 'blocked' })
  })

  it('does not take "I\'ve stopped merging" for a session that stopped', () => {
    const s = at('2026-11-12T04:04:00Z')
    expect(session(s, 'cloud-reviewer').status).not.toBe('stopped')
  })

  it('shows the picture as it was at any moment of the night', () => {
    const s = at('2026-11-12T03:30:00Z')
    expect(session(s, 'cloud-conductor')).toMatchObject({ status: 'working' })
    expect(session(s, 'cloud-reviewer')).toBeUndefined() // it first posted at 03:46
    expect(s.events.every((e: Json) => e.at <= '2026-11-12T03:30:00Z')).toBe(true)
  })
})

describe('health at the end of the night', () => {
  const h = at().health

  it('alerts that there is no orchestrator heartbeat (the PC had restarted)', () => {
    expect(h.heartbeat.orchestrator).toMatchObject({ state: 'missing', stale: true, alert: true })
    expect(h.alerts[0].key).toBe('heartbeat')
  })

  it('finds the revert PR that went red after its author stopped', () => {
    expect(h.orphaned_prs).toEqual([expect.objectContaining({ pr: 159, reason: 'red', author: 'cloud-reviewer', author_state: 'stopped' })])
  })

  it('finds the owner decision that was only asked in a status comment', () => {
    expect(h.stray_decisions).toEqual([expect.objectContaining({ who: 'cloud-reviewer', about: [158, 159] })])
    expect(h.open_decisions).toBe(0)
  })

  it('does not count a "Decision needed: none" as a decision', () => {
    expect(h.stray_decisions.map((d: Json) => d.who)).not.toContain('agent-phone-lab')
  })

  it('lists sessions silent with work in flight, not every agent that ever posted', () => {
    const names = h.silent_sessions.map((s: Json) => s.name)
    expect(names).toContain('cloud-black-screen') // blocked on the phone, PR #141 open
    expect(names).not.toContain('agent-probe') // its PR #20 merged long ago
    expect(names).not.toContain('cloud-reviewer') // stopped
  })

  it('reports label drift the night left behind', () => {
    expect(h.label_drift).toEqual(expect.arrayContaining([
      { issue: 98, problem: 'more than one priority (p2, p3)' },
      { issue: 112, problem: 'closed but still in-progress' },
      { issue: 81, problem: 'in-progress with no claim comment' },
    ]))
  })

  it('puts the PRs that ask for the phone in the phone queue', () => {
    expect(h.phone_gated).toEqual(expect.arrayContaining([151, 153]))
    expect(h.phone_gated).not.toContain(162)
  })

  it('counts the night\'s merges', () => {
    expect(at().events.filter((e: Json) => e.kind === 'merged')).toHaveLength(44)
  })
})

// Small boards in the new format: the exact rules.
const comment = (id: number, created_at: string, body: string, updated_at = created_at) => ({ id, created_at, updated_at, body })
const board = (comments: Json[], extra: Json = {}) => ({
  repo: 'o/r', fetched_at: '2026-11-12T12:00:00Z', window_hours: 48, board_comments: comments,
  issues: [], issue_comments: {}, pulls: [], merged: [], main: { newest_completed: { conclusion: 'success', head_sha: 'abcdef1234', html_url: 'u', created_at: '2026-11-12T11:00:00Z' } },
  ...extra,
})
const status = (name: string, lines: string) => `status: ${name} (cloud)\n${lines}`
const pr = (n: number, over: Json = {}) => ({
  number: n, title: `PR ${n}`, body: '', draft: false, head_ref: `claude/x-${n}`, head_sha: 'aaaaaaa1111', base_ref: 'main', labels: [],
  created_at: '2026-11-12T08:00:00Z', updated_at: '2026-11-12T08:00:00Z', html_url: 'u', mergeable: true, mergeable_state: 'clean',
  head_committed_at: '2026-11-12T08:00:00Z', required: { status: 'completed', conclusion: 'success' }, comments: [], build: null, ...over,
})

describe('the status format', () => {
  it('parses every key exactly', () => {
    const s = parseStatus(comment(1, '2026-11-12T10:00:00Z', status('cloud-builder-84', 'role: builder\nstate: waiting\nwhere: claude/issue-84-x, PR #135\nworking on: #84 switch moment\ndone: PR #135\nnext: answer review\nblocked: none\nasks: orchestrator: delete claude/old')))
    expect(s).toMatchObject({ name: 'cloud-builder-84', surface: 'cloud', role: 'builder', state: 'waiting', branch: 'claude/issue-84-x', issue: 84, prs: [135], blocked: null, asks: 'orchestrator: delete claude/old', formatted: true })
  })

  it('ignores comments that are not statuses', () => {
    expect(parseStatus(comment(1, 't', '**Owner rule for every session**'))).toBeNull()
  })
})

describe('heartbeat', () => {
  const hb = (updated: string, state = 'active') => comment(9, '2026-11-11T20:00:00Z', `heartbeat: orchestrator\nsession: local-orchestrator\nstate: ${state}\nnext tick: 10`, updated)

  it('takes its time from the edit, not from when the comment was first posted', () => {
    expect(parseHeartbeat(hb('2026-11-12T11:50:00Z'))?.at).toBe('2026-11-12T11:50:00Z')
    expect(derive(board([hb('2026-11-12T11:50:00Z')])).health.heartbeat.orchestrator).toMatchObject({ age_min: 10, stale: false, alert: false, comment_id: 9 })
  })

  it('is stale after 90 minutes and alerts after 3 hours', () => {
    expect(derive(board([hb('2026-11-12T10:29:00Z')])).health.heartbeat.orchestrator).toMatchObject({ stale: true, alert: false })
    expect(derive(board([hb('2026-11-12T08:59:00Z')])).health.heartbeat.orchestrator).toMatchObject({ stale: true, alert: true })
  })

  it('lets the understudy act at once while the orchestrator is away, without an alert', () => {
    const h = derive(board([hb('2026-11-12T11:40:00Z', 'away until 2026-11-12T14:00:00Z')])).health
    expect(h.heartbeat.orchestrator).toMatchObject({ state: 'away', stale: true, alert: false })
    expect(h.ok).toBe(true)
  })
})

describe('PRs', () => {
  it('needs the phone by label or by the words in the body, until phone-verified', () => {
    const s = derive(board([], { pulls: [pr(1, { labels: ['needs-phone'] }), pr(2, { body: 'Ready.\n\nPHONE CHECK NEEDED: lock and unlock.' }), pr(3, { labels: ['needs-phone', 'phone-verified'] }), pr(4)] }))
    expect(s.phoneQueue.map((q: Json) => q.pr)).toEqual([1, 2])
    expect(s.phoneQueue[1].steps).toEqual(['PHONE CHECK NEEDED: lock and unlock.'])
  })

  it('does not take a PR that only quotes the marker for one that asks for the phone (#159, #167)', () => {
    const quoted = ["#158's own description said **\"PHONE CHECK NEEDED before merge\"**: at night...", '| phone | `needs-phone`, or `PHONE CHECK NEEDED` in the body |']
    const s = derive(board([], { pulls: quoted.map((body, i) => pr(i + 1, { body })).concat([pr(9, { body: 'x\n\nPHONE CHECK NEEDED before merge\n1. lock' })]) }))
    expect(s.phoneQueue.map((q: Json) => q.pr)).toEqual([9])
  })

  it('reads the phone check steps from their section', () => {
    const s = derive(board([], { pulls: [pr(1, { labels: ['needs-phone'], body: '## What\nx\n\n## Phone check\n1. Dark mode\n2. Lock, unlock\n\n## How verified\ny' })] }))
    expect(s.phoneQueue[0].steps).toEqual(['1. Dark mode', '2. Lock, unlock'])
  })

  it('is orphaned only when red or conflicting and nobody pushed for 2 h', () => {
    const red = { required: { status: 'completed', conclusion: 'failure' } }
    const s = derive(board([], { pulls: [pr(1, { ...red, head_committed_at: '2026-11-12T09:59:00Z' }), pr(2, { ...red, head_committed_at: '2026-11-12T10:30:00Z' }), pr(3, { mergeable_state: 'dirty', mergeable: false }), pr(4)] }))
    expect(s.health.orphaned_prs.map((p: Json) => [p.pr, p.reason])).toEqual([[1, 'red'], [3, 'conflicting']])
  })

  it('knows whether a verdict is about the current head commit', () => {
    const verdict = (sha: string) => [comment(5, '2026-11-12T09:00:00Z', `verdict: approve ${sha}\nlooks right`)]
    expect(derive(board([], { pulls: [pr(1, { comments: verdict('aaaaaaa') })] })).prs[0].verdict).toMatchObject({ verdict: 'approve', current: true })
    expect(derive(board([], { pulls: [pr(1, { comments: verdict('bbbbbbb') })] })).prs[0].verdict).toMatchObject({ current: false })
  })
})

describe('decisions', () => {
  it('parses question, recommendation and options', () => {
    expect(parseDecision('Decision needed: Raise the budget?\nRecommendation: yes, by 5 kB\nOptions: (a) raise (b) cut dev code (c) drop a part')).toEqual({
      question: 'Raise the budget?', recommendation: 'yes, by 5 kB', options: ['(a) raise', '(b) cut dev code', '(c) drop a part'],
    })
  })

  it('queues needs-human issues and flags one with no Decision needed comment', () => {
    const issues = [{ number: 7, title: 'Budget', state: 'open', labels: ['needs-human'] }, { number: 8, title: 'Wording', state: 'open', labels: ['needs-human', 'ready'] }]
    const s = derive(board([], { issues, issue_comments: { 7: [comment(3, '2026-11-12T09:00:00Z', 'Decision needed: Raise it?\nRecommendation: yes\nOptions: (a) yes (b) no')] } }))
    expect(s.decisions.map((d) => [d.issue, d.question])).toEqual([[7, 'Raise it?'], [8, null]])
    expect(s.health.label_drift).toEqual([{ issue: 8, problem: 'needs-human with no "Decision needed:" comment' }, { issue: 8, problem: 'needs-human and ready' }])
  })

  it('stops calling a status decision stray once it is on a needs-human issue', () => {
    const c = [comment(1, '2026-11-12T10:00:00Z', status('cloud-x', 'role: builder\nstate: blocked\nblocked: Decision needed on #7: raise the budget?'))]
    expect(derive(board(c, { issues: [{ number: 7, title: 'B', state: 'open', labels: [] }] })).health.stray_decisions).toHaveLength(1)
    expect(derive(board(c, { issues: [{ number: 7, title: 'B', state: 'open', labels: ['needs-human'] }] })).health.stray_decisions).toHaveLength(0)
  })
})

describe('sessions in the new format', () => {
  it('reports a dispatched session that never posted', () => {
    const s = derive(board([comment(1, '2026-11-12T10:00:00Z', 'dispatch: cloud-builder-84 (cloud)\nrole: builder\nworking on: #84\nby: local-orchestrator')]))
    expect(s.health.dispatched_silent).toEqual([{ name: 'cloud-builder-84', dispatched_at: '2026-11-12T10:00:00Z', silent_h: 2 }])
    expect(s.events[0]).toMatchObject({ who: 'local-orchestrator', kind: 'dispatched', what: 'cloud-builder-84 as builder on #84' })
  })

  it('collects asks for the orchestrator from sessions still running', () => {
    const c = [comment(1, '2026-11-12T11:00:00Z', status('cloud-ci', 'role: builder\nstate: waiting\nasks: orchestrator: delete claude/proof-before'))]
    expect(derive(board(c)).health.asks).toEqual([{ who: 'cloud-ci', at: '2026-11-12T11:00:00Z', ask: 'orchestrator: delete claude/proof-before' }])
  })

  it('reads the lab window, also across midnight', () => {
    expect(parseLabWindow(comment(1, '2026-11-12T23:10:00Z', 'lab-window: until 06:30 UTC'))?.until).toBe('2026-11-13T06:30:00.000Z')
    expect(derive(board([comment(1, '2026-11-12T11:00:00Z', 'lab-window: until 11:30 UTC')])).health.lab_window.open).toBe(false)
  })

  it('merges the local roster and events without duplicates', () => {
    const s = derive(board([comment(1, '2026-11-12T10:00:00Z', status('cloud-x', 'role: builder\nstate: working'))]))
    const m = mergeLocal(s, { sessions: [{ id: 'dev-18', name: 'dev-18', last_seen: '2026-11-12T11:00:00Z' }], events: [...s.events, { at: '2026-11-12T11:00:00Z', who: 'dev-18', kind: 'went-idle', what: '' }] })
    expect(m.sessions.map((x: Json) => x.id)).toEqual(['dev-18', 'cloud-x'])
    expect(m.events).toHaveLength(s.events.length + 1)
  })
})

describe('what the owner reads', () => {
  it('keeps a table row whole whatever a session writes (CodeQL js/incomplete-sanitization on #165)', () => {
    const c = [comment(1, '2026-11-12T11:00:00Z', status('cloud-x', 'role: builder\nstate: working\nworking on: #5 path C:\\a\\| b | c'))]
    const row = renderBoard(derive(board(c))).split('\n').find((l) => l.startsWith('| `cloud-x`')) ?? ''
    // A cell boundary is a pipe preceded by an even number of backslashes.
    const boundaries = [...row.matchAll(/(\\*)\|/g)].filter((m) => m[1].length % 2 === 0)
    expect(boundaries).toHaveLength(7)
  })


  it('the board says plainly when there is no orchestrator', () => {
    expect(renderBoard(at())).toContain('Orchestrator: **no heartbeat on this issue**. The understudy is acting.')
  })

  it('the morning report leads with the phone, then what needs the owner', () => {
    const pulls = [pr(1, { labels: ['needs-phone'], comments: [comment(5, '2026-11-12T06:00:00Z', 'phone-result: fail aaaaaaa · locked-wrong-turn · black screen after Start drive')] })]
    const text = renderMorning(derive(board([], { pulls })))
    expect(text.indexOf('**On the phone**')).toBeLessThan(text.indexOf('**Needs you**'))
    expect(text).toContain('#1 PR 1: **failed**, locked-wrong-turn · black screen after Start drive')
  })

  it('the alert carries a stable key so it comments only when something new goes wrong', () => {
    const a = renderAlert(at())
    expect(a.ok).toBe(false)
    expect(a.body).toContain(`<!-- alert-keys: ${a.keys.join(',')} -->`)
    expect(renderAlert(derive(board([comment(9, 't', 'heartbeat: orchestrator\nsession: x', '2026-11-12T11:59:00Z')]))).ok).toBe(true)
  })

  it('writes every file the dashboard reads, with the fields it reads', () => {
    const files = outputs(at())
    expect(Object.keys(files).sort()).toEqual(['alert.md', 'board.md', 'decisions.json', 'events.json', 'health.json', 'issues.json', 'morning.md', 'phone-queue.json', 'prs.json', 'sessions.json', 'state.json'])
    const s0 = JSON.parse(files['sessions.json'])[0]
    for (const k of ['id', 'name', 'kind', 'surface', 'where', 'branch', 'role', 'working_on', 'issue', 'status', 'last_seen']) expect(s0).toHaveProperty(k)
    const e0 = JSON.parse(files['events.json'])[0]
    expect(Object.keys(e0).sort()).toEqual(['at', 'kind', 'what', 'who'])
  })
})

// Comments typed in GitHub's web editor arrive with CRLF, and a Windows checkout gives the
// fixture CRLF too: the state must be the same as from LF.
describe('CRLF in comment bodies', () => {
  it('derives exactly the same files from the night with every line ending CRLF', () => {
    const crlf: Json = JSON.parse(JSON.stringify(night, (_k, v) => (typeof v === 'string' ? v.replace(/\n/g, '\r\n') : v)))
    const now = '2026-11-12T11:33:00Z'
    expect(outputs(derive(crlf, { now }))).toEqual(outputs(derive(night, { now })))
  })
})
