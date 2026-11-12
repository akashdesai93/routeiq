/**
 * What the phone lab can say about how the page is laid out and painted, for
 * a screen that is in the DOM but not on the glass (#136: the driving screen
 * black on the iPhone). Sizes in whole CSS pixels, CSS values and class
 * names: nothing about where the phone is. Only called in lab mode.
 */

const BOXES = ['html', 'body', '#root', '.app', '.main', '.map', '.mapboxgl-canvas', '.live-top', '.live-bottom'] as const
const STYLES = ['display', 'position', 'visibility', 'opacity', 'backgroundColor', 'overflow', 'zIndex', 'transform', 'contain'] as const

const name = (el: Element) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className !== '' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`

/** One line of JSON. Never throws: a part that cannot be read is left out. */
export function layoutProbe(doc: Document, win: Window): string {
  const out: Record<string, unknown> = {}
  try {
    out.window = [win.innerWidth, win.innerHeight]
    out.visual = win.visualViewport ? [Math.round(win.visualViewport.width), Math.round(win.visualViewport.height)] : null
    out.scroll = [Math.round(win.scrollX), Math.round(win.scrollY)]
    out.page = [doc.documentElement.scrollWidth, doc.documentElement.scrollHeight]
    const boxes: Record<string, unknown> = {}
    for (const selector of BOXES) {
      const el = doc.querySelector(selector)
      if (el === null) {
        boxes[selector] = null
        continue
      }
      const r = el.getBoundingClientRect()
      const cs = win.getComputedStyle(el)
      const styles = STYLES.map((s) => `${s}=${cs[s]}`).filter((s) => !/=(none|normal|visible|static|auto|1|block)$/.test(s))
      boxes[selector] = { box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], styles }
    }
    out.boxes = boxes
    // What is on top at three points down the middle of the screen, front to back.
    const x = Math.round(win.innerWidth / 2)
    out.onTop = [0.12, 0.5, 0.9].map((share) =>
      doc
        .elementsFromPoint(x, Math.round(win.innerHeight * share))
        .slice(0, 5)
        .map(name),
    )
    const canvas = doc.querySelector<HTMLCanvasElement>('.mapboxgl-canvas')
    if (canvas !== null) {
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
      out.canvas = { size: [canvas.width, canvas.height], shown: [canvas.clientWidth, canvas.clientHeight], contextLost: gl === null ? 'no context' : gl.isContextLost() }
    }
    out.pixelRatio = win.devicePixelRatio
    out.hidden = doc.hidden
  } catch {
    out.failed = true
  }
  return JSON.stringify(out)
}

/** Things to try on a screen that will not paint, by name. Each returns what it did. */
export const LAYOUT_FIXES: Readonly<Record<string, (doc: Document, win: Window) => string>> = {
  /** What turning the phone or the keyboard closing does: the map re-measures itself. */
  resize: (_doc, win) => {
    win.dispatchEvent(new Event('resize'))
    return 'sent a resize event'
  },
  /** Takes the app out of the layout and puts it back. */
  reflow: (doc) => {
    const app = doc.querySelector<HTMLElement>('.app')
    if (app === null) return 'no .app'
    app.style.display = 'none'
    void app.offsetHeight
    app.style.display = ''
    return 'hid and showed .app'
  },
  /** Gives the app its own compositing layer. */
  layer: (doc) => {
    const app = doc.querySelector<HTMLElement>('.app')
    if (app === null) return 'no .app'
    app.style.transform = 'translateZ(0)'
    return 'transform: translateZ(0) on .app'
  },
  /** Without the map (WebGL): are the cards painted then? */
  nomap: (doc) => {
    const map = doc.querySelector<HTMLElement>('.map')
    if (map === null) return 'no .map'
    map.style.display = 'none'
    return 'hid .map'
  },
  /** Is the app's own background what is on the glass? If the screen turns red, nothing is drawn over it. */
  red: (doc) => {
    const app = doc.querySelector<HTMLElement>('.app')
    if (app === null) return 'no .app'
    app.style.background = 'red'
    return 'background: red on .app'
  },
  /** Back to the top of the page, in case the plan screen was left scrolled. */
  scroll: (_doc, win) => {
    win.scrollTo(0, 0)
    return 'scrolled to the top'
  },
}
