// Renders the app icons in public/icons/ from public/icons/icon.svg (#9), in headless
// Chromium, so they are made the same way every time. Run after changing the SVG:
//   node scripts/design/app-icons.mjs
// - icon-192.png, icon-512.png: the manifest's "any" icons (full bleed).
// - icon-maskable-512.png: the mark shrunk into the middle 80 %, which Android may crop to a circle.
// - apple-touch-icon.png: 180 x 180 for iPhone's Add to Home Screen (iOS rounds the corners itself).
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/icons')
const svg = readFileSync(path.join(dir, 'icon.svg'), 'utf8')
// The maskable icon: the same picture with the mark scaled to 80 % about the centre.
const maskable = svg.replace('<g id="mark">', '<g id="mark" transform="translate(256 256) scale(0.8) translate(-256 -256)">')
if (maskable === svg) throw new Error('icon.svg has no <g id="mark"> to scale for the maskable icon')

const outputs = [
  { file: 'icon-192.png', size: 192, source: svg },
  { file: 'icon-512.png', size: 512, source: svg },
  { file: 'icon-maskable-512.png', size: 512, source: maskable },
  { file: 'apple-touch-icon.png', size: 180, source: svg },
]

const browser = await chromium.launch()
try {
  for (const { file, size, source } of outputs) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    const sized = source.replace('<svg ', `<svg width="${size}" height="${size}" `)
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:#050607}svg{display:block}</style>${sized}`)
    await page.screenshot({ path: path.join(dir, file), omitBackground: false })
    await page.close()
    console.log(`public/icons/${file}: ${size} x ${size}`)
  }
} finally {
  await browser.close()
}
