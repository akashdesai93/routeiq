#!/usr/bin/env node
// Publishes what state.mjs wrote (docs/orchestrator.md, "The board, the alert and the morning
// report"). Run by .github/workflows/board.yml; safe to run by hand with --dry-run.
//
//   node scripts/orch/publish.mjs --dir orch-state [--board] [--alert] [--morning] [--dry-run]
//
// --board    replaces the body of #17 with board.md (and nothing else in that issue)
// --alert    keeps one issue labelled orch-alert open while health has alerts: opens or reopens
//            it, edits its body every time, comments only when the list of problems changes,
//            closes it when all is clear
// --morning  posts morning.md on #17 once per UTC day
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ALERT_LABEL = 'orch-alert'
export const ALERT_TITLE = 'Fleet alert'
const BOARD = 17

/** The alert keys stored in an alert body ("<!-- alert-keys: a,b -->"). */
export function keysOf(body) {
  const m = /<!-- alert-keys: ([^>]*?) -->/.exec(String(body || ''))
  return m ? m[1].split(',').map((k) => k.trim()).filter(Boolean).sort() : []
}

/**
 * What to do with the alert issue. Pure.
 * existing: { number, state, body } | null; alert: { ok, keys, body }
 * → { action: 'none' | 'create' | 'reopen' | 'update' | 'close', comment: string | null }
 */
export function alertAction(existing, alert) {
  if (alert.ok) {
    if (existing && existing.state === 'open') return { action: 'close', comment: 'All clear. Closing until something needs attention again.' }
    return { action: 'none', comment: null }
  }
  if (!existing) return { action: 'create', comment: null }
  const before = keysOf(existing.body)
  const added = alert.keys.filter((k) => !before.includes(k))
  const summary = alert.body.split('\n').filter((l) => l.startsWith('- ')).join('\n')
  if (existing.state !== 'open') return { action: 'reopen', comment: `Needs attention again:\n\n${summary}` }
  if (added.length) return { action: 'update', comment: `New since the last check: ${added.join(', ')}\n\n${summary}` }
  return { action: 'update', comment: null }
}

/** True if #17 already has today's morning report (comments newest last). */
export function hasMorningToday(comments, nowIso) {
  const day = nowIso.slice(0, 10)
  return comments.some((c) => String(c.body || '').startsWith(`morning report · ${day}`))
}

function gh(args, { input } = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 })
}
function bodyFile(text) {
  const f = join(mkdtempSync(join(tmpdir(), 'orch-')), 'body.md')
  writeFileSync(f, text)
  return f
}

function main() {
  const argv = process.argv.slice(2)
  const dirAt = argv.indexOf('--dir')
  if (dirAt < 0 || !argv[dirAt + 1]) throw new Error('--dir <state.mjs output folder> is required')
  const dir = argv[dirAt + 1]
  const dry = argv.includes('--dry-run')
  const repo = process.env.GITHUB_REPOSITORY || 'akashdesai93/routeiq'
  const R = `repos/${repo}`
  const act = (what, args) => {
    console.log(`${dry ? 'dry run: ' : ''}${what}`)
    if (!dry) gh(args)
  }
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))

  if (argv.includes('--board')) {
    act(`replace the body of #${BOARD}`, ['api', '-X', 'PATCH', `${R}/issues/${BOARD}`, '-F', `body=@${bodyFile(readFileSync(join(dir, 'board.md'), 'utf8'))}`, '--jq', '.html_url'])
  }

  if (argv.includes('--alert')) {
    const body = readFileSync(join(dir, 'alert.md'), 'utf8')
    const alert = { ok: state.health.alerts.length === 0, keys: keysOf(body), body }
    const found = JSON.parse(gh(['api', `${R}/issues?labels=${ALERT_LABEL}&state=all&per_page=5&sort=created&direction=desc`]))
      .filter((i) => !i.pull_request)[0]
    const existing = found ? { number: found.number, state: found.state, body: found.body } : null
    const { action, comment } = alertAction(existing, alert)
    console.log(`alert: ${action}${existing ? ` #${existing.number}` : ''} (${alert.keys.length} problem(s))`)
    if (action === 'create') {
      try { gh(['api', '-X', 'POST', `${R}/labels`, '-f', `name=${ALERT_LABEL}`, '-f', 'color=b60205', '-f', 'description=The fleet needs attention (board.yml)']) } catch { /* the label exists */ }
      act('open the alert issue', ['api', '-X', 'POST', `${R}/issues`, '-f', `title=${ALERT_TITLE}`, '-F', `body=@${bodyFile(body)}`, '-f', `labels[]=${ALERT_LABEL}`, '--jq', '.html_url'])
    }
    if (action === 'reopen' || action === 'update') {
      act(`${action} #${existing.number}`, ['api', '-X', 'PATCH', `${R}/issues/${existing.number}`, '-f', 'state=open', '-F', `body=@${bodyFile(body)}`, '--jq', '.html_url'])
    }
    if (comment) act(`comment on #${existing.number}`, ['api', '-X', 'POST', `${R}/issues/${existing.number}/comments`, '-F', `body=@${bodyFile(comment)}`, '--jq', '.html_url'])
    if (action === 'close') {
      act(`update and close #${existing.number}`, ['api', '-X', 'PATCH', `${R}/issues/${existing.number}`, '-f', 'state=closed', '-f', 'state_reason=completed', '-F', `body=@${bodyFile(body)}`, '--jq', '.html_url'])
    }
  }

  if (argv.includes('--morning')) {
    const since = new Date(Date.now() - 24 * 3600e3).toISOString()
    const comments = JSON.parse(gh(['api', `${R}/issues/${BOARD}/comments?since=${since}&per_page=100`]))
    if (hasMorningToday(comments, state.generated_at)) console.log('morning report: already posted today')
    else act(`post the morning report on #${BOARD}`, ['api', '-X', 'POST', `${R}/issues/${BOARD}/comments`, '-F', `body=@${bodyFile(readFileSync(join(dir, 'morning.md'), 'utf8'))}`, '--jq', '.html_url'])
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
