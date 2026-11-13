#!/usr/bin/env node
// First paint of the production build on a slow phone, offline.
//
//   npm run e2e:build && node scripts/perf/firstpaint.mjs [dist-e2e] [runs]
//
// Serves the build from disk on a local port (as the iPhone shell serves www/ from the
// app bundle), opens it in headless Chromium at phone size with the CPU slowed 4 times
// (roughly an iPhone running this JavaScript) and answers nothing outside localhost:
// Mapbox, its tiles and its telemetry are refused, so only the app's own work is timed.
// Prints, per run and as median / p95 in ms from navigation start:
//   fcp      first contentful paint (the browser's paint timing)
//   panel    the plan panel is on screen (".side .plan" or the first ".side" child)
//   map      Mapbox has made its canvas (the map chunk is loaded and running)
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { chromium } from 'playwright'

const dir = resolve(process.argv[2] ?? 'dist-e2e')
const runs = Number(process.argv[3] ?? 15)
const CPU_SLOWDOWN = 4
if (!existsSync(join(dir, 'index.html'))) {
  console.error(`${dir}/index.html is missing. Run \`npm run e2e:build\` first.`)
  process.exit(1)
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' }
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
  let file = join(dir, path)
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html')
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  createReadStream(file).pipe(res)
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch()
const rows = []
for (let i = 0; i < runs + 1; i++) {
  // A new context each run: nothing cached, as on a first open after an app update.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await context.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()))
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN })
  await page.goto(url, { waitUntil: 'commit' })
  await page.waitForSelector('.side > *', { state: 'visible', timeout: 60_000 })
  const panel = await page.evaluate(() => performance.now())
  await page.waitForSelector('canvas.mapboxgl-canvas', { state: 'attached', timeout: 60_000 })
  const map = await page.evaluate(() => performance.now())
  const fcp = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? NaN)
  await context.close()
  if (i === 0) continue // warm-up: the first run pays for starting the browser
  rows.push({ fcp, panel, map })
  console.log(`run ${i}: fcp ${fcp.toFixed(0)}  panel ${panel.toFixed(0)}  map ${map.toFixed(0)}`)
}
await browser.close()
server.close()

const pick = (key, q) => {
  const sorted = rows.map((r) => r[key]).toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
}
console.log(`\n${runs} runs, CPU ${CPU_SLOWDOWN}x slower, ${dir}`)
console.log('| | median | p95 |\n| --- | ---: | ---: |')
for (const key of ['fcp', 'panel', 'map']) console.log(`| ${key} | ${pick(key, 0.5).toFixed(0)} ms | ${pick(key, 0.95).toFixed(0)} ms |`)
