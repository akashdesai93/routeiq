---
name: design-tokens
description: RouteIQ's design tokens (colour, type, size, radius, spacing, motion) from the approved merged direction, what each one means and the rules for using them in src/*.css. Use whenever you write or review CSS or markup a driver sees, pick a colour or a font size, or add a new state to a screen.
---

# RouteIQ design tokens

The approved look (design/README.md, "The merged direction", decided in #21 and #22) is
**Vector's black glass on a real map, condensed numerals, amber as the only news colour,
calm plain sentences**. The mock-ups are in `design/exports/merged/`; the reference CSS is
`design/src/merged/merged.css`. The app's tokens are CSS custom properties with the same
names. Use the token, never the raw value, and never invent a near-copy.

## Colour (dark, the default while driving)

| Token | Value | Means | Contrast on `--glass` |
|---|---|---|---|
| `--bg` | `#050607` | the page behind everything | |
| `--glass` | `#0b0d10` | cards and sheets on the map | |
| `--raised` | `#171a1f` | a control or tile inside a sheet | |
| `--hair` | `#2c3138` | hairline borders (decoration only) | 1.5:1 |
| `--hair2` | `#59616c` | grabber, off toggle, quiet outlines | 3.1:1 (UI only) |
| `--fg` | `#f2f4f6` | text, the primary (filled white) button | 17.6:1 |
| `--dim` | `#9aa1ab` | units, labels, secondary text | 7.5:1 |
| `--amber` | `#ffb000` | **news only**: a pending or confirmed switch | 10.6:1 |
| `--on-amber` | `#0a0a0a` | text on an amber fill | 11:1 |
| `--old` | `#646c77` | the route being left, struck-through old figures | |
| `--raised2` | `#20242b` | a raised control under the pointer, a selected route card | |
| `--danger` | `#ff8a80` | a failed field or a refused token, always with words | |

Daylight (`design/src/merged/merged.css`, the light block) flips to black on white with a
pale map. There, amber is only ever a **fill under black text** (amber on white is 1.8:1),
and the amber route branch gets a black casing.

## Type

- Figures and street names: `--figure` = Barlow Condensed 500/600, `font-variant-numeric:
  tabular-nums`, `line-height: 1`. Sentences: Inter 600. Both bundled (`src/fonts.css`),
  never fetched. No monospace on anything shown while driving.
- Sizes while driving: turn distance 76 px, ETA 54 px, street 30 px, tile figure 34 px,
  banner sentence 18 px, labels and units 14.5 px. **Nothing under 14 px while driving**;
  nothing under 13 px anywhere; inputs 16 px (iOS zooms on focus below that).
- Units are smaller and `--dim` beside their digits ("0.8 mi": the `Figure` component).

## Size, radius, spacing

- Touch: 60 px for drive controls (More, End, Keep my route), 44 px minimum for anything
  tapped. Tiles 68 px. Gaps 8 / 12 / 14 px; sheet side padding 16 px plus safe area.
- Radius: turn card 24 px, sheet 28 px (top corners), buttons and tiles 16 px, chips 999 px.
- Safe areas: every edge-anchored element uses `max(<gap>, env(safe-area-inset-*))`.

## Motion

Transforms and opacity only, 200 to 300 ms, `cubic-bezier(0.25, 0.8, 0.25, 1)`; nothing
loops while driving; every animation has a `prefers-reduced-motion: reduce` off switch.
The once-a-second tick must not move layout: fixed-height boxes, `contain: layout paint`.

## Rules

1. **Amber means news.** Only the switch (pending outline, confirmed fill) and its route
   branch are amber. A warning, a badge or a test-mode label is not news: use `--raised`
   with `--fg` text and words.
2. **One filled button per screen**, white (`--fg` on `--bg`). Everything else raised or
   outlined.
3. **Colour is never the only signal**: words, a tick, a hatch or a shape say it too.
4. **Check contrast** for any new pair: `node scripts/design/contrast.mjs <fg> <bg>`
   (AA: 4.5:1 text, 3:1 large text and UI).
5. Tokens live once (on `:root` at the top of `src/index.css`, since #85; every screen reads them). Add a token there and to the
   table above in the same PR; don't redefine a value locally.
6. The e2e design guards (`e2e/design.spec.ts`: axe, touch targets, text sizes,
   overflow) must stay green; a token change that breaks one is a regression.
