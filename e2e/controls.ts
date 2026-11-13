// Which controls the scenarios tap (#203).
//
// Runs inside the page (page.addInitScript), next to browserStubs.ts. It keeps two lists for
// the guard (e2e/controls-guard.mjs):
//
// - seen: every interactive control that was on screen at some moment of the scenario
//   (buttons, links, toggles, inputs, sheet handles, list rows), read from the rendered DOM
//   as it changes;
// - activated: every control that received a *trusted* click, tap or typed input, which is
//   what Playwright's click/tap/fill/check/press produce and what a call into the code
//   (element.click(), dispatchEvent) does not.
//
// A control is named by where it is and what it says: `<area> › <role> "<name>"`, with every
// run of digits as "#" so that "Drives (3)" and "Take it (12 s)" stay one control. Each new
// name is handed to the test through the exposed binding __controlsRecord, so a reload or a
// second page loses nothing.
//
// It must be self-contained: Playwright serializes this function into the page.

/** `tapped` is sent on every activation (for the tap review); `seen` and `activated` once per name. */
export type ControlEvent = { kind: 'seen' | 'activated' | 'tapped'; key: string }

export function installControlRecorder(): void {
  type Recorder = (event: { kind: 'seen' | 'activated' | 'tapped'; key: string }) => Promise<void>
  const w = window as unknown as Window & { __controlsRecord?: Recorder }
  const CONTROL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=option], [role=switch], [role=checkbox], [role=tab], [role=slider], [onclick]'
  const AREA = '[role=dialog], dialog, [role=listbox], aside, section, header, nav, details, [aria-label]'
  // Controls whose words are data (a route's figures, a place's name): one name for the kind.
  const KINDS: readonly (readonly [string, string])[] = [
    ['ol.routes button.route', 'a route in the list'],
    ['[role=option]', 'a search suggestion'],
    ['button.place-go', 'a recent destination'],
    ['[aria-label="Go to a saved place"] button.chip:not(.unset)', 'a saved place'],
    ['[aria-label="Saved places"] button[aria-label^="Remove "]', 'Remove (a saved place)'],
    ['.mapboxgl-marker', 'a map pin'],
    ['[aria-label="Saved places"] form input', 'New name for a saved place'],
  ]
  // Not a control a finger can use: read-only text it can only select, and a disabled control
  // (the same control enabled is in the list under its own words, "Use my location" for "Locating…").
  const isOutput = (el: Element) =>
    ((el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && el.readOnly) || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true'
  const sent = new Set<string>()

  const squash = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().replace(/\d+([.,:]\d+)*/g, '#').slice(0, 60)

  const role = (el: Element): string => {
    const explicit = el.getAttribute('role')
    if (explicit !== null) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'summary') return 'summary'
    if (tag === 'select') return 'select'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type
      if (type === 'checkbox' || type === 'radio' || type === 'range') return type
      if (type === 'submit' || type === 'button') return 'button'
      return 'textbox'
    }
    return 'button'
  }

  const name = (el: Element): string => {
    for (const [selector, kind] of KINDS) if (el.matches(selector)) return kind
    // "Drives (3)", "Last drive (saved Nov 12, 8 AM)": the words in brackets are a count or a date.
    return words(el).replace(/\s*\([^)]*\)/g, '').trim()
  }

  const words = (el: Element): string => {
    const label = el.getAttribute('aria-label')
    if (label !== null && label.trim() !== '') return squash(label)
    const by = el.getAttribute('aria-labelledby')
    if (by !== null) return squash(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '))
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const own = el.labels?.[0]?.textContent
      if (own) return squash(own)
      if ('placeholder' in el && el.placeholder) return squash(el.placeholder)
      return squash(el.name || el.id)
    }
    return squash(el.textContent)
  }

  const area = (el: Element): string => {
    const box = el.parentElement?.closest(AREA)
    if (box === null || box === undefined) return 'page'
    const label = box.getAttribute('aria-label')
    if (label !== null && label.trim() !== '') return squash(label)
    if (box.tagName === 'DETAILS') return squash(box.querySelector(':scope > summary')?.textContent) || 'details'
    const heading = box.querySelector('h1, h2, h3, legend')
    if (heading?.textContent) return squash(heading.textContent)
    return box.tagName.toLowerCase() + (box.classList[0] ? `.${box.classList[0]}` : '')
  }

  const keyOf = (el: Element) => `${area(el)} › ${role(el)} "${name(el)}"`

  const visible = (el: Element) => {
    const box = el.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return false
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    const style = getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none'
  }

  const send = (kind: 'seen' | 'activated', key: string) => {
    const id = `${kind}\u0000${key}`
    if (sent.has(id)) return
    sent.add(id)
    void w.__controlsRecord?.({ kind, key }).catch(() => {})
  }

  const look = (root: ParentNode) => {
    const found: Element[] = root instanceof Element && root.matches(CONTROL) ? [root] : []
    found.push(...root.querySelectorAll(CONTROL))
    for (const el of found) if (!isOutput(el) && visible(el)) send('seen', keyOf(el))
  }

  // Each change is looked at where it happened, not the whole page, so a long drive stays fast.
  // A class or `open` change on a panel can show what is inside it: that subtree is looked at.
  const observer = new MutationObserver((mutations) => {
    const roots = new Set<ParentNode>()
    for (const m of mutations) {
      if (m.type === 'characterData') {
        const control = m.target.parentElement?.closest(CONTROL)
        if (control) roots.add(control)
      } else if (m.target instanceof Element) roots.add(m.target)
    }
    for (const root of roots) if (root instanceof Element && root.isConnected) look(root)
  })
  const start = () => {
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'open', 'hidden', 'disabled', 'style', 'aria-expanded', 'aria-hidden'] })
    look(document)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
  // Layout alone (a resize, a font) can bring a control into view without a DOM change.
  window.addEventListener('resize', () => look(document))

  const activated = (event: Event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return
    const control = event.target.closest(CONTROL) ?? (event.target instanceof HTMLLabelElement ? event.target.control : null)
    if (control && !isOutput(control)) {
      send('seen', keyOf(control))
      send('activated', keyOf(control))
      void w.__controlsRecord?.({ kind: 'tapped', key: keyOf(control) }).catch(() => {})
    }
  }
  // Capture phase: a control that removes itself when tapped is still named as it was.
  for (const type of ['click', 'input', 'change']) window.addEventListener(type, activated, { capture: true })
  // A map pin is dragged, not clicked: a finger or mouse pressed on it counts.
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.isTrusted && event.target instanceof Element && event.target.closest('.mapboxgl-marker')) activated(event)
    },
    { capture: true },
  )
}
