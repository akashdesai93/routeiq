// The tap review set (#203): every tap, click and typing of the tap scenarios, with a screenshot
// before and after it, at phone size, as one browsable page.
//
//   npm run review:taps                  Chromium at 390 x 844 (the @tap scenarios)
//   npm run review:taps -- --webkit      the webkit-iphone project (iPhone 14 profile)
//   npm run review:taps -- --sheet-only  only rebuild the page from the last run
//   (any other arguments go to Playwright, e.g. -g "saved places")
//
// Writes e2e-report/taps/index.html (the contact sheet: one row per action, before | after,
// what was tapped, and the control the page saw activated), the pictures next to it, and
// shots.json with the same in data. It is the input of the design and function review a
// separate reviewer makes (docs/tap-review.md); it asserts nothing itself.
//
// Run `npm run e2e:build` first (the script does it unless --no-build).

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const args = process.argv.slice(2)
const take = (flag) => {
  const at = args.indexOf(flag)
  if (at < 0) return false
  args.splice(at, 1)
  return true
}
const webkit = take('--webkit')
const sheetOnly = take('--sheet-only')
const noBuild = take('--no-build')
const results = 'e2e-report/results'
const out = webkit ? 'e2e-report/taps-webkit' : 'e2e-report/taps'

if (!sheetOnly) {
  if (!noBuild) {
    const build = spawnSync('npm run e2e:build', { shell: true, stdio: 'inherit' })
    if (build.status !== 0) process.exit(build.status ?? 1)
  }
  const grep = args.some((a) => a === '-g' || a === '--grep' || a.startsWith('--grep=')) ? [] : ['-g', '@tap']
  const config = ['--project', webkit ? 'webkit-iphone' : 'chromium']
  const run = spawnSync(`npx playwright test ${[...config, ...grep, ...args].map((a) => JSON.stringify(a)).join(' ')}`, {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, E2E_TAP_SHOTS: '1' },
  })
  // A failed scenario still leaves its shots up to the failure: the sheet is made either way.
  if (run.status !== 0) console.error(`playwright exited ${run.status}; the sheet shows what was taken`)
}

/** Every taps.json under `dir`. */
function find(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return find(path)
    return entry === 'taps.json' ? [path] : []
  })
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const scenarios = find(results)
  .map((path) => ({ path, ...JSON.parse(readFileSync(path, 'utf8')) }))
  .sort((a, b) => a.title.localeCompare(b.title))
if (scenarios.length === 0) {
  console.error(`no taps.json under ${results}: nothing was recorded`)
  process.exit(1)
}

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const data = []
const sections = scenarios.map((scenario, s) => {
  const base = dirname(scenario.path)
  const rows = scenario.shots.map((shot) => {
    const pic = (side) => {
      const from = join(base, shot[side])
      const to = join(out, `s${String(s + 1).padStart(2, '0')}-${String(shot.n).padStart(3, '0')}-${side}.png`)
      if (existsSync(from)) copyFileSync(from, to)
      return relative(out, to).replaceAll('\\', '/')
    }
    const before = pic('before')
    const after = pic('after')
    data.push({ scenario: scenario.title, project: scenario.project, n: shot.n, action: shot.action, target: shot.target, activated: shot.activated, before, after })
    return `<figure class="row" id="s${s + 1}-${shot.n}">
  <figcaption><b>${shot.n}. ${esc(shot.action)}</b> <code>${esc(shot.target)}</code><br>${shot.activated.length > 0 ? `activated: ${shot.activated.map(esc).join('; ')}` : '<em>no control saw a trusted tap</em>'}</figcaption>
  <div class="pair"><a href="${before}"><img loading="lazy" src="${before}" alt="before"></a><a href="${after}"><img loading="lazy" src="${after}" alt="after"></a></div>
</figure>`
  })
  return `<section><h2>${esc(scenario.title)}${scenario.project ? ` <small>[${esc(scenario.project)}]</small>` : ''}</h2>\n${rows.join('\n')}</section>`
})

writeFileSync(join(out, 'shots.json'), JSON.stringify(data, null, 1))
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tap review</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1b1f24; --muted: #59636e; --line: #d1d9e0 }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d } }
  body { margin: 0 auto; max-width: 1100px; padding: 16px; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg) }
  h2 { margin-top: 32px; font-size: 17px } small, figcaption { color: var(--muted) } code { color: var(--fg) }
  .row { margin: 0 0 20px; padding-bottom: 12px; border-bottom: 1px solid var(--line) }
  .pair { display: flex; gap: 8px; margin-top: 6px } .pair a { flex: 1 1 0; min-width: 0 }
  .pair img { width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px }
</style>
<h1>Tap review</h1>
<p>${data.length} actions in ${scenarios.length} scenarios${webkit ? ', WebKit (iPhone 14 profile, 390 × 844)' : ', Chromium at 390 × 844'}. Each row: the screen before the action, and 0.4 s after it.</p>
${sections.join('\n')}
`,
)
console.log(`tap review: ${data.length} actions in ${scenarios.length} scenarios -> ${out}/index.html`)
