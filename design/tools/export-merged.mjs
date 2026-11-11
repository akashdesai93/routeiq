// Export the merged direction into exports/merged/.
//   npm run export:merged [-- <filter>]   (the dev server must be running: npm run dev)
// With a filter, only outputs whose file name contains it are written
// (for example `-- -43-` for issue 43's files).
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const U = 'http://127.0.0.1:5273'
const OUT = 'exports/merged'
const only = process.argv[2]
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  const last = (r.stdout + r.stderr).trim().split('\n').filter((l) => /->|frames|failed|Error/.test(l)).slice(-1)[0]
  console.log(`${args.slice(0, 2).join(' ')}: ${last ?? 'done'}`)
}
const want = (out) => !only || out.includes(only)
const still = (name, out, width) => want(out) && run(process.execPath, ['scripts/film.mjs', `${U}/?capture=${name}`, '--out', `${OUT}/${out}`, '--still', ...(width ? ['--width', String(width)] : [])])
const loop = (name, base) => {
  if (!want(base)) return
  run(process.execPath, ['scripts/film.mjs', `${U}/?capture=${name}`, '--out', `${OUT}/${base}-contact-sheet.png`, '--every', '750', '--count', '12', '--cols', '6', '--width', '520'])
  run(process.execPath, ['tools/record.mjs', name, `shots/rec-${name}`])
  run('python', ['tools/gif.py', `shots/rec-${name}`, `${OUT}/${base}.gif`, '80', '402'])
}

mkdirSync(OUT, { recursive: true })
still('merged-compare', 'merged-comparison.png', 1740)
still('merged-plan', 'merged-1-plan.png')
still('merged-pick', 'merged-2-pick-a-route.png')
still('merged-drive', 'merged-3-driving.png')
still('merged-more', 'merged-4-more-sheet.png')
still('merged-switch-pending', 'merged-5-switch-pending.png')
still('merged-switch', 'merged-6-switch-confirmed.png')
still('merged-drive-day', 'merged-7-driving-daylight.png')
still('merged-switch-day', 'merged-8-switch-daylight.png')
still('merged-signals', 'merged-signal-states.png', 1300)
loop('merged-loop', 'merged-switch-loop')
// #43 Keep my route
still('merged-declined', 'merged-43-keep-my-route-declined.png')
still('merged-again', 'merged-43-offered-again-after-10-min.png')
loop('merged-loop-keep', 'merged-43-keep-my-route-loop')
// #44 partial and unknown light counts while driving
still('merged-signals-driving', 'merged-44-signal-states-while-driving.png', 1340)
still('merged-partial-pending', 'merged-44-driving-partial-coverage-pending.png')
still('merged-partial-more', 'merged-44-more-sheet-partial.png')
still('merged-unknown-more', 'merged-44-more-sheet-unknown.png')
// #45 turn card wording when there is no turn soon
still('merged-straight', 'merged-45-driving-no-turn-soon.png')
still('merged-straight-day', 'merged-45-driving-no-turn-soon-daylight.png')
still('merged-turn-cards', 'merged-45-turn-card-wording.png', 1340)
