import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DASHBOARD_FILES, dashboardFiles, recommendedOption } from '../../scripts/orch/dashboard.mjs'
import { derive, mergeLocal, type Json } from '../../scripts/orch/derive.mjs'
import { parseHeartbeat, parseStatus } from '../../scripts/orch/lib/status.mjs'

// #180: the owner's dashboard is fed from state.mjs alone, so a session that ended without
// saying `stopped` must read as done, not as working; and the orchestrator's heartbeat must
// beat even when a tick writes the same lines as the last one.

const night: Json = JSON.parse(readFileSync('tests/orch/night-2026-11-12.json', 'utf8'))
const files = (state: Json) => Object.fromEntries(Object.entries(dashboardFiles(state)).map(([k, v]) => [k, JSON.parse(v as string)]))

const comment = (id: number, created_at: string, body: string, updated_at = created_at) => ({ id, created_at, updated_at, body })
const board = (comments: Json[], extra: Json = {}) => ({
  repo: 'o/r', fetched_at: '2026-11-12T12:00:00Z', window_hours: 48, board_comments: comments,
  issues: [], issue_comments: {}, pulls: [], merged: [], main: { newest_completed: { conclusion: 'success', head_sha: 'abcdef1234', html_url: 'u', created_at: '2026-11-12T11:00:00Z' } },
  ...extra,
})
const status = (name: string, lines: string, at = '2026-11-12T09:00:00Z') => comment(1, at, `status: ${name} (cloud)\nrole: builder\n${lines}`)
const pr = (n: number, over: Json = {}) => ({
  number: n, title: `PR ${n}`, body: '', draft: false, head_ref: `claude/x-${n}`, head_sha: 'aaaaaaa1111', base_ref: 'main', labels: [],
  created_at: '2026-11-12T08:00:00Z', updated_at: '2026-11-12T08:00:00Z', html_url: 'u', mergeable: true, mergeable_state: 'clean',
  head_committed_at: '2026-11-12T08:00:00Z', required: { status: 'completed', conclusion: 'success' }, comments: [], build: null, ...over,
})
const issue = (n: number, labels: string[] = ['in-progress']) => ({ number: n, title: `Issue ${n}`, state: 'open', labels, updated_at: '2026-11-12T08:00:00Z' })
const session = (state: Json, name: string) => state.sessions.find((s: Json) => s.name === name)

describe('sessions that ended without saying so (the night of 2026-11-12)', () => {
  const end = derive(night)
  const dash = files(end)
  const row = (name: string) => dash['sessions.json'].find((s: Json) => s.name === name)

  it('shows the night\'s dead builders as done, not working or waiting', () => {
    // Both still "said" waiting/working; their PRs (#105, #90) merged hours ago and #86 is claimed by someone else.
    for (const name of ['agent-shell-testing', 'agent-usb-simloc', 'agent-ci-protect', 'cloud-builder']) {
      expect(row(name)).toMatchObject({ status: 'done', group: 'done' })
      expect(row(name)).not.toHaveProperty('waiting_on')
    }
  })

  it('keeps a quiet session with an open PR of its own alive', () => {
    expect(row('cloud-black-screen')).toMatchObject({ status: 'blocked', group: 'blocked' }) // PR #141 open
    expect(row('cloud-battery')).toMatchObject({ status: 'working', group: 'phone', waiting_on: 'the phone' }) // #151, #153 need the phone
  })

  it('drops the dead sessions from the silent alert, and only them', () => {
    expect(end.health.silent_sessions.map((s: Json) => s.name)).toEqual(['cloud-black-screen', 'cloud-battery'])
    expect(end.health.alerts.map((a: Json) => a.key)).not.toContain('silent-agent-shell-testing')
  })

  it('leaves no one working who has nothing open', () => {
    const live = dash['sessions.json'].filter((s: Json) => s.status !== 'done')
    expect(live.map((s: Json) => s.name).sort()).toEqual(['cloud-battery', 'cloud-black-screen', 'cloud-black-screen-2', 'cloud-orch-hardening', 'cloud-perf-2'])
  })
})

describe('when a session has ended', () => {
  const at = '2026-11-12T09:30:00Z' // 2.5 h before the snapshot
  const claim = { 7: [comment(5, '2026-11-12T09:00:00Z', 'claude-loop: claimed by cloud-x')] }

  it('is alive while it holds a claim, even with no PR, and then it counts as silent', () => {
    const s = derive(board([status('cloud-x', 'state: working\nworking on: #7 x', at)], { issues: [issue(7)], issue_comments: claim }))
    expect(session(s, 'cloud-x')).toMatchObject({ ended: false, group: 'working' })
    expect(s.health.silent_sessions.map((x: Json) => x.name)).toEqual(['cloud-x'])
  })

  it('is done when the issue it names is open but claimed by nobody (or someone else)', () => {
    const s = derive(board([status('cloud-x', 'state: working\nworking on: #7 x', at)], { issues: [issue(7, ['ready'])] }))
    expect(session(s, 'cloud-x')).toMatchObject({ ended: true, group: 'done' })
    expect(s.health.silent_sessions).toEqual([])
  })

  it('is not done before the silent threshold, with nothing open', () => {
    const s = derive(board([status('cloud-x', 'state: working\nworking on: #7 x', '2026-11-12T10:01:00Z')]))
    expect(session(s, 'cloud-x')).toMatchObject({ ended: false })
  })
})

describe('groups and PR stages', () => {
  const one = (labels: string[], over: Json = {}, state = 'waiting') => {
    const s = derive(board([status('cloud-x', `state: ${state}\nwhere: claude/x-1, PR #1`, '2026-11-12T11:30:00Z')], { pulls: [pr(1, { labels, ...over })] }))
    return { group: session(s, 'cloud-x').group, pr: files(s)['prs.json'][0] }
  }

  it('is review when its PRs wait for a verdict, phone when one needs the phone, blocked when one needs the owner', () => {
    expect(one([])).toMatchObject({ group: 'review', pr: { stage: 'review', checks: 'green', conflicting: false } })
    expect(one(['needs-phone'])).toMatchObject({ group: 'phone', pr: { stage: 'phone' } })
    expect(one(['needs-phone', 'phone-verified'])).toMatchObject({ group: 'review', pr: { stage: 'review' } })
    expect(one(['needs-human'])).toMatchObject({ group: 'blocked', pr: { stage: 'blocked' } })
  })

  it('is working while its PR is unfinished, red or conflicting', () => {
    expect(one(['do-not-merge'])).toMatchObject({ group: 'working', pr: { stage: 'building' } })
    expect(one([], { draft: true })).toMatchObject({ pr: { stage: 'building', draft: true } })
    expect(one([], { required: { status: 'completed', conclusion: 'failure' } })).toMatchObject({ group: 'working', pr: { stage: 'fixing', checks: 'red' } })
    expect(one([], { mergeable_state: 'dirty', mergeable: false })).toMatchObject({ pr: { stage: 'fixing', conflicting: true } })
    expect(one([], { required: { status: 'in_progress' } })).toMatchObject({ pr: { checks: 'pending' } })
  })
})

describe('the dashboard files', () => {
  it('are exactly the six the page reads', () => {
    expect(Object.keys(dashboardFiles(derive(night))).sort()).toEqual([...DASHBOARD_FILES].sort())
    expect(DASHBOARD_FILES).toHaveLength(6)
  })

  it('give a link only when the status carries one (not the cloud footer)', () => {
    const footer = '\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_'
    const s = derive(board([
      comment(1, '2026-11-12T11:00:00Z', `status: cloud-a (cloud)\nrole: builder\nstate: working\nlink: https://example.org/run/1${footer}`),
      comment(2, '2026-11-12T11:01:00Z', `status: cloud-b (cloud)\nrole: builder\nstate: working${footer}`),
    ]))
    const rows = files(s)['sessions.json']
    expect(rows.find((r: Json) => r.name === 'cloud-a').link).toBe('https://example.org/run/1')
    expect(rows.find((r: Json) => r.name === 'cloud-b')).not.toHaveProperty('link')
    expect(parseStatus(comment(3, 't', `status: cloud-c\nstate: working${footer}`))?.link).toBeNull()
  })

  it('name the recommended option of a decision', () => {
    const opts = ['(a) per-PR change files', '(b) keep bumping per PR', '(c) drop the integer']
    expect(recommendedOption('(b): fewer files', opts)).toBe('(b) keep bumping per PR')
    expect(recommendedOption('Keep bumping per PR, only the conductor bumps', opts)).toBe('(b) keep bumping per PR')
    expect(recommendedOption('Free now', ['Free now', 'Later tonight'])).toBe('Free now')
    expect(recommendedOption('wait and see', opts)).toBeNull()
    const s = derive(board([], { issues: [issue(7, ['needs-human'])], issue_comments: { 7: [comment(3, '2026-11-12T09:00:00Z', 'Decision needed: Raise it?\nRecommendation: (a) now\nOptions: (a) yes (b) no')] } }))
    expect(files(s)['decisions.json']).toEqual([{ issue: 7, question: 'Raise it?', recommendation: '(a) now', options: ['(a) yes', '(b) no'], recommended: '(a) yes' }])
  })

  it('hold health as one row, with what the PC knows about the phone merged in', () => {
    const hb = comment(9, '2026-11-12T08:00:00Z', 'heartbeat: orchestrator\nsession: local-orchestrator\nstate: active', '2026-11-12T11:50:00Z')
    const s = derive(board([hb], { pulls: [pr(1, { labels: ['needs-phone'], comments: [comment(5, '2026-11-12T06:00:00Z', 'phone-result: fail aaaaaaa · drive · black')] })] }))
    expect(files(s)['health.json']).toEqual([{ main: 'green', phone_build: 'PR #1 at aaaaaaa (fail)', phone_state: '1 PR waiting for the phone', heartbeat_at: '2026-11-12T11:50:00Z', notes: 'All clear.' }])
    const local = mergeLocal(s, { health: { phone_build: 'New look: PR 141 build', phone_state: 'with the owner' } })
    expect(files(local)['health.json'][0]).toMatchObject({ phone_build: 'New look: PR 141 build', phone_state: 'with the owner', main: 'green' })
  })

  it('list issues by stage and open and merged PRs together', () => {
    const s = derive(board([], {
      issues: [issue(3, ['needs-human', 'p2', 'area:infra']), { ...issue(4, ['in-progress']), state: 'closed' }, issue(5, ['ready', 'p3'])],
      pulls: [pr(9)], merged: [{ number: 8, title: 'Old', merged_at: '2026-11-12T10:00:00Z', head_ref: 'claude/old', html_url: 'u8' }],
    }))
    const f = files(s)
    expect(f['issues.json'].map((i: Json) => [i.number, i.stage, i.priority, i.area])).toEqual([[5, 'ready', 'p3', ''], [4, 'done', '', ''], [3, 'needs-human', 'p2', 'infra']])
    expect(f['prs.json'].map((p: Json) => [p.number, p.state])).toEqual([[9, 'OPEN'], [8, 'MERGED']])
  })
})

describe('the heartbeat beats on every tick', () => {
  const body = (tick?: string) => `heartbeat: orchestrator\nsession: local-orchestrator\nstate: active\nnext tick: 10${tick ? `\ntick: ${tick}` : ''}`

  it('is fresh when a tick rewrote the same lines (GitHub kept updated_at) but its tick line is new', () => {
    // Edited at 09:00 for real; the 11:55 tick's write left updated_at alone.
    const hb = comment(9, '2026-11-11T20:00:00Z', body('2026-11-12T11:55Z'), '2026-11-12T09:00:00Z')
    expect(parseHeartbeat(hb)?.at).toBe('2026-11-12T11:55:00Z')
    expect(derive(board([hb])).health.heartbeat.orchestrator).toMatchObject({ age_min: 5, stale: false, alert: false })
  })

  it('reads the tick in the forms people write it', () => {
    for (const t of ['2026-11-12T11:55:00Z', '2026-11-12 11:55 UTC', '2026-11-12T11:55Z']) expect(parseHeartbeat(comment(9, 'x', body(t), '2026-11-12T09:00:00Z'))?.tick).toBe('2026-11-12T11:55:00Z')
    expect(parseHeartbeat(comment(9, 'x', body('soon'), '2026-11-12T09:00:00Z'))?.at).toBe('2026-11-12T09:00:00Z')
  })

  it('without a tick line, is as old as its last real edit', () => {
    expect(derive(board([comment(9, '2026-11-11T20:00:00Z', body(), '2026-11-12T09:00:00Z')])).health.heartbeat.orchestrator).toMatchObject({ age_min: 180, alert: true })
  })

  it('never counts a tick from the future as later than now, nor an edit after now', () => {
    const ahead = comment(9, '2026-11-11T20:00:00Z', body('2026-11-12T13:00Z'), '2026-11-12T11:00:00Z')
    expect(derive(board([ahead])).health.heartbeat.orchestrator).toMatchObject({ at: '2026-11-12T12:00:00Z', age_min: 0 })
    expect(derive(board([ahead]), { now: '2026-11-12T10:00:00Z' }).health.heartbeat.orchestrator.state).toBe('missing')
  })
})
