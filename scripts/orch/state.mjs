#!/usr/bin/env node
// The fleet's state, from GitHub alone (docs/orchestrator.md).
//
//   node scripts/orch/state.mjs --out tmp/orch            # read GitHub, write every file below
//   node scripts/orch/state.mjs --from raw.json --out d   # the same from a saved snapshot (tests, replays)
//   node scripts/orch/state.mjs --save-raw raw.json       # also keep the snapshot
//   node scripts/orch/state.mjs --print heartbeat-id      # the orchestrator's heartbeat comment id ('' if none)
//   node scripts/orch/state.mjs --print health|board|morning
//   options: --repo owner/name (default $GITHUB_REPOSITORY or akashdesai93/routeiq), --now <ISO>,
//            --window-hours N, --local local.json ({ sessions, events } from the local fleet)
//
// Files: state.json (everything), sessions.json, prs.json, issues.json, events.json,
// decisions.json, health.json, phone-queue.json, board.md, morning.md, alert.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderAlert, renderBoard, renderMorning } from './board.mjs'
import { DEFAULT_ORCH_OPTIONS } from './defaults.mjs'
import { derive, mergeLocal } from './derive.mjs'

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`)
    const key = a.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${a} needs a value`)
    out[key] = value
    i++
  }
  return out
}

/** Every output file's name and text, from a derived state. */
export function outputs(state) {
  const json = (x) => `${JSON.stringify(x, null, 2)}\n`
  return {
    'state.json': json(state),
    'sessions.json': json(state.sessions),
    'prs.json': json(state.prs),
    'issues.json': json(state.issues),
    'events.json': json(state.events),
    'decisions.json': json(state.decisions),
    'health.json': json(state.health),
    'phone-queue.json': json({ generated_at: state.generated_at, items: state.phoneQueue }),
    'board.md': renderBoard(state),
    'morning.md': renderMorning(state),
    'alert.md': renderAlert(state).body,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repo = args.repo || process.env.GITHUB_REPOSITORY || 'akashdesai93/routeiq'
  const windowHours = Number(args['window-hours'] || DEFAULT_ORCH_OPTIONS.windowHours)
  let raw
  if (args.from) raw = JSON.parse(readFileSync(args.from, 'utf8'))
  else {
    const { collect } = await import('./github.mjs')
    raw = collect({ repo, windowHours, log: (m) => console.error(`state: ${m}`) })
  }
  if (args['save-raw']) writeFileSync(args['save-raw'], `${JSON.stringify(raw, null, 2)}\n`)
  let state = derive(raw, { now: args.now, windowHours })
  if (args.local) state = mergeLocal(state, JSON.parse(readFileSync(args.local, 'utf8')))
  const files = outputs(state)
  if (args.out) {
    mkdirSync(args.out, { recursive: true })
    for (const [name, text] of Object.entries(files)) writeFileSync(join(args.out, name), text)
    console.error(`state: wrote ${Object.keys(files).length} files to ${args.out}; health ${state.health.ok ? 'ok' : `${state.health.alerts.length} alert(s)`}`)
  }
  const print = args.print
  if (print === 'heartbeat-id') console.log(state.health.heartbeat.orchestrator.comment_id ?? '')
  else if (print === 'health') process.stdout.write(files['health.json'])
  else if (print === 'board') process.stdout.write(files['board.md'])
  else if (print === 'morning') process.stdout.write(files['morning.md'])
  else if (print) throw new Error(`--print: heartbeat-id, health, board or morning, not "${print}"`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`state: ${err.message}`)
    process.exitCode = 1
  })
}
