// Record one full loop of a stage as numbered PNG frames, for tools/gif.py.
// The stage's clock and every CSS transition run SLOW times slower while the
// frames are taken, so each frame is a true moment of the loop, evenly spaced.
//   node tools/record.mjs <capture-name> <out-dir> [width] [height]
import { mkdirSync, rmSync } from 'node:fs'
import { launch } from '../scripts/browser.mjs'

const [name, out, w = '488', h = '960'] = process.argv.slice(2)
const SLOW = 5
const STEP = 80 // ms of scene time between frames
const browser = await launch()
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 })
await page.addInitScript((slow) => { window.__stageshow = { slow } }, SLOW)
const cdp = await page.context().newCDPSession(page)
await cdp.send('Animation.enable')
await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / SLOW })
await page.goto(`http://127.0.0.1:5273/?capture=${name}`)
await page.waitForSelector('.ss-stage')
await page.evaluate(() => document.fonts.ready)
const mark = () => page.evaluate(() => document.querySelector('.ss-stage')?.getAttribute('data-mark'))
const until = async (m) => { while ((await mark()) !== m) await page.waitForTimeout(20) }
// Skip the first loop (first paint settles in it); record the second, start to start
await until('reset')
await until('start')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const stage = page.locator('.ss-stage').first()
const t0 = Date.now()
let seenReset = false
for (let i = 0; i < 400; i++) {
  const due = t0 + i * STEP * SLOW
  const wait = due - Date.now()
  if (wait > 0) await page.waitForTimeout(wait)
  const m = await mark()
  if (m === 'reset') seenReset = true
  if (seenReset && m === 'start') break
  await stage.screenshot({ path: `${out}/${String(i).padStart(4, '0')}.png` })
}
await browser.close()
console.log(`recorded ${name} -> ${out}, ${STEP}ms per frame`)
