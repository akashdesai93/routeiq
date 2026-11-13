// What is actually on the screen, read from a screenshot's pixels rather than
// from the page's DOM. The DOM can hold the turn card while the phone shows a
// black screen (#136): only the pixels tell the two apart.

import type { Page } from '@playwright/test'

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ScreenFacts {
  /** The share of the screen taken by its most common colour (to 1/16 per channel). 1 is a flat screen. */
  readonly dominantShare: number
  /** The most common colour, as #rrggbb (quantised). */
  readonly dominant: string
  /** Mean luminance (0 dark to 1 light) of each box asked about. */
  readonly meanLight: readonly number[]
  /** The share of light pixels (luminance over 0.75) in each box. */
  readonly lightShare: readonly number[]
  /** The share of dark pixels (luminance under 0.2) in each box. */
  readonly darkShare: readonly number[]
}

/**
 * Takes a screenshot and measures it, inside the page (the browser decodes the
 * PNG, so no image library is needed). Boxes are in CSS pixels of the viewport.
 */
export async function screenFacts(page: Page, boxes: readonly Box[]): Promise<ScreenFacts> {
  const png = (await page.screenshot({ scale: 'css' })).toString('base64')
  return page.evaluate(
    async ({ png, boxes }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${png}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0)
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const luminance = (i: number) => (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255

      const counts = new Map<number, number>()
      for (let i = 0; i < data.length; i += 4) {
        const key = ((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      let top = 0
      let topKey = 0
      for (const [key, n] of counts) if (n > top) [top, topKey] = [n, key]
      const hex = (v: number) => ((v << 4) | 8).toString(16).padStart(2, '0')

      const meanLight: number[] = []
      const lightShare: number[] = []
      const darkShare: number[] = []
      for (const box of boxes) {
        const x0 = Math.max(0, Math.floor(box.x))
        const y0 = Math.max(0, Math.floor(box.y))
        const x1 = Math.min(width, Math.ceil(box.x + box.width))
        const y1 = Math.min(height, Math.ceil(box.y + box.height))
        let sum = 0
        let light = 0
        let dark = 0
        let n = 0
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const l = luminance((y * width + x) * 4)
            sum += l
            if (l > 0.75) light++
            if (l < 0.2) dark++
            n++
          }
        }
        meanLight.push(n === 0 ? 0 : sum / n)
        lightShare.push(n === 0 ? 0 : light / n)
        darkShare.push(n === 0 ? 0 : dark / n)
      }
      return {
        dominantShare: top / (width * height),
        dominant: `#${hex(topKey >> 8)}${hex((topKey >> 4) & 15)}${hex(topKey & 15)}`,
        meanLight,
        lightShare,
        darkShare,
      }
    },
    { png, boxes },
  )
}
