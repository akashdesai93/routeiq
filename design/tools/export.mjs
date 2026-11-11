// Export everything the owner looks at into exports/.
//   npm run export        (the dev server must be running: npm run dev)
// Stills and contact sheets come from the Stageshow film script; the GIFs are
// recorded frame by frame (tools/record.mjs) and assembled with Pillow
// (tools/gif.py), so nothing beyond Chrome, Node and Python is needed.
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const U = 'http://127.0.0.1:5273'
const DIRS = ['clearway', 'noodle', 'vector']
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  const last = (r.stdout + r.stderr).trim().split('\n').filter((l) => /->|frames|failed|Error/.test(l)).slice(-1)[0]
  console.log(`${args.slice(0, 2).join(' ')}: ${last ?? 'done'}`)
}
const film = (name, out, ...flags) => run(process.execPath, ['scripts/film.mjs', `${U}/?capture=${name}`, '--out', out, ...flags])

mkdirSync('exports', { recursive: true })
// The comparison: the hero moment in all three (the reduced-motion poster), and every screen on one sheet
film('compare', 'exports/comparison.png', '--still', '--reduced', '--width', '1300')
film('compare-all', 'exports/comparison-all-nine-screens.png', '--still', '--width', '1300')
for (const d of DIRS) {
  mkdirSync(`exports/${d}`, { recursive: true })
  film(`${d}-pick`, `exports/${d}/${d}-1-pick-a-route.png`, '--still')
  film(`${d}-drive`, `exports/${d}/${d}-2-driving.png`, '--still')
  film(`${d}-switch`, `exports/${d}/${d}-3-automatic-switch.png`, '--still')
  film(`${d}-loop`, `exports/${d}/${d}-loop-contact-sheet.png`, '--every', '750', '--count', '12', '--cols', '6', '--width', '520')
  run(process.execPath, ['tools/record.mjs', `${d}-loop`, `shots/rec-${d}`])
  run('python', ['tools/gif.py', `shots/rec-${d}`, `exports/${d}/${d}-loop.gif`, '80', '402'])
}
run(process.execPath, ['tools/record.mjs', 'compare', 'shots/rec-compare', '1300', '970'])
run('python', ['tools/gif.py', 'shots/rec-compare', 'exports/comparison-loop.gif', '80', '1080'])
