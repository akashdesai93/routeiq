// Puts screenshots side by side on one page, captioned, for a quick review.
//   node scripts/design/contact-sheet.mjs out.png 280 design-shots/iphone-390/*.png
// Width is each picture's width in CSS pixels; four to a row. Uses the
// Playwright that the e2e scenarios already install (no download, no network).
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const [out, width, ...files] = process.argv.slice(2)
if (out === undefined || files.length === 0) {
  console.error('usage: node scripts/design/contact-sheet.mjs <out.png> <width> <png...>')
  process.exit(2)
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const w = Number(width)
const cells = files
  .map((f) => `<figure><figcaption>${esc(basename(f, '.png'))}</figcaption><img src="data:image/png;base64,${readFileSync(f).toString('base64')}" width="${w}"></figure>`)
  .join('')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 4 * (w + 16), height: 400 } })
await page.setContent(`<style>body{margin:0;display:flex;flex-wrap:wrap;gap:8px;font:12px system-ui,sans-serif;background:#d0d3d8}figure{margin:4px;width:${w}px}figcaption{height:2.6em;overflow:hidden}</style>${cells}`)
await page.screenshot({ path: out, fullPage: true })
await browser.close()
