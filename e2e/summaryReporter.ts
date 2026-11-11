// A one-page report of the e2e run for someone who does not read test code:
// each scenario as a sentence, passed or failed, its screenshots in order,
// what the app said out loud, what the made-up traffic server answered, and
// the video. Written to e2e-report/index.html next to Playwright's own report
// (e2e-report/playwright), which has the traces for digging into a failure.

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter'

interface Row {
  title: string
  file: string
  status: TestResult['status']
  expected: boolean
  durationMs: number
  error: string | null
  shots: { name: string; path: string }[]
  texts: { name: string; body: string }[]
  video: string | null
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
// Terminal colour codes in error messages.
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '')

export default class SummaryReporter implements Reporter {
  private readonly outputFile: string
  private readonly dir: string
  private readonly rows: Row[] = []
  private started = Date.now()

  constructor(options: { outputFile?: string } = {}) {
    this.outputFile = options.outputFile ?? 'e2e-report/index.html'
    this.dir = dirname(this.outputFile)
  }

  onBegin() {
    this.started = Date.now()
    rmSync(join(this.dir, 'evidence'), { recursive: true, force: true })
    mkdirSync(join(this.dir, 'evidence'), { recursive: true })
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const index = this.rows.length + 1
    const row: Row = {
      title: test.title,
      file: relative(process.cwd(), test.location.file).replaceAll('\\', '/'),
      status: result.status,
      expected: result.status === test.expectedStatus,
      durationMs: result.duration,
      error: result.error?.message ? plain(result.error.message) : null,
      shots: [],
      texts: [],
      video: null,
    }
    for (const a of result.attachments) {
      if (a.contentType === 'image/png' && a.body !== undefined) {
        const path = `evidence/${index}-${row.shots.length + 1}.png`
        writeFileSync(join(this.dir, path), a.body)
        row.shots.push({ name: a.name.replace(/^\d+ /, ''), path })
      } else if (a.contentType === 'text/plain' && a.body !== undefined) {
        row.texts.push({ name: a.name, body: a.body.toString('utf8') })
      } else if (a.contentType.startsWith('video/') && a.path !== undefined && existsSync(a.path)) {
        const path = `evidence/${index}.webm`
        copyFileSync(a.path, join(this.dir, path))
        row.video = path
      }
    }
    this.rows.push(row)
  }

  onEnd(result: FullResult) {
    const passed = this.rows.filter((r) => r.expected).length
    const seconds = Math.round((Date.now() - this.started) / 1000)
    const when = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    const cards = this.rows
      .sort((a, b) => a.file.localeCompare(b.file))
      .map((r) => {
        const ok = r.expected
        const badge = ok ? (r.status === 'passed' ? 'Works' : 'Known bug, as expected') : r.status === 'skipped' ? 'Skipped' : 'Broken'
        const shots = r.shots
          .map((s) => `<figure><a href="${s.path}"><img src="${s.path}" alt="${esc(s.name)}" loading="lazy"></a><figcaption>${esc(s.name)}</figcaption></figure>`)
          .join('')
        const texts = r.texts
          .map((t, i) => `<details${i === 0 ? ' open' : ''}><summary>${esc(t.name)}</summary><pre>${esc(t.body)}</pre></details>`)
          .join('')
        return `<article class="${ok ? 'ok' : 'bad'}">
  <header><span class="badge">${badge}</span><h2>${esc(r.title)}</h2><span class="meta">${(r.durationMs / 1000).toFixed(1)} s · ${esc(r.file)}</span></header>
  ${r.error !== null && !ok ? `<pre class="error">${esc(r.error)}</pre>` : ''}
  ${shots === '' ? '' : `<div class="shots">${shots}</div>`}
  ${texts}
  ${r.video === null ? '' : `<details><summary>video</summary><video controls preload="none" src="${r.video}"></video></details>`}
</article>`
      })
      .join('\n')
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RouteIQ scenarios</title>
<style>
:root { --bg: #f6f7f5; --card: #fff; --text: #1d2321; --muted: #5d6763; --ok: #1a7f3c; --bad: #b42318; --line: #dfe3e0; }
@media (prefers-color-scheme: dark) { :root { --bg: #141716; --card: #1d2120; --text: #e8ece9; --muted: #9aa49f; --ok: #4cc46f; --bad: #ff6b5e; --line: #2e3432; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { margin: 0 0 4px; font-size: 24px; }
.lead { color: var(--muted); margin: 0 0 20px; }
.total { font-size: 18px; font-weight: 600; margin-bottom: 20px; }
article { background: var(--card); border: 1px solid var(--line); border-left: 6px solid var(--ok); border-radius: 8px; padding: 14px 16px; margin: 0 0 16px; }
article.bad { border-left-color: var(--bad); }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
h2 { margin: 0; font-size: 17px; flex: 1 1 400px; }
.badge { font-weight: 700; color: var(--ok); }
.bad .badge { color: var(--bad); }
.meta { color: var(--muted); font-size: 13px; }
.shots { display: flex; gap: 10px; overflow-x: auto; padding: 10px 0 4px; }
figure { margin: 0; flex: 0 0 260px; }
figure img { width: 100%; border: 1px solid var(--line); border-radius: 4px; display: block; }
figcaption { font-size: 13px; color: var(--muted); margin-top: 4px; }
details { margin-top: 8px; }
summary { cursor: pointer; color: var(--muted); }
pre { background: var(--bg); padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 13px; margin: 6px 0 0; }
pre.error { color: var(--bad); white-space: pre-wrap; }
video { width: 100%; max-width: 800px; margin-top: 6px; }
</style></head>
<body><main>
<h1>RouteIQ: what works, shown end to end</h1>
<p class="lead">Each scenario runs the real app (the production build) in a browser, fully offline: routes come from a made-up road network between public landmarks, and the GPS, the voice and the clock are simulated. Run ${esc(when)}. Screenshots are in order; "spoken lines" is everything the app said out loud, with the drive time; "route answers" is what the made-up traffic server offered at each request. Playwright's detailed report, with traces of any failure, is in <a href="playwright/index.html">playwright/</a>.</p>
<p class="total">${passed} of ${this.rows.length} scenarios behave as expected · ${seconds} s · run ${result.status}</p>
${cards}
</main></body></html>
`
    writeFileSync(this.outputFile, html)
  }

  printsToStdio() {
    return false
  }
}
