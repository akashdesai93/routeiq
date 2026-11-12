---
name: ux-review
description: Audit a RouteIQ screen (or a PR's UI change) the way a driver meets it - phone in a mount, two-second glances, sunlight or night - with screenshots at iPhone sizes and findings ranked by what they cost the driver. Use before and after changing anything a driver sees, when reviewing a UI PR, or when asked "does this look right / is this good UX".
---

# UX review for a driver

RouteIQ is used on an iPhone in a car mount, often at arm's length, in sunlight or at
night, with the phone sometimes locked. A screen is good when the driver gets what they
need in **one glance under two seconds** and can act with **one thumb, without looking
twice**. Judge against that, not against taste.

## 1. Get evidence first (never review from code alone)

```bash
npm run design:shots           # every screen and state, offline, ~1 min
# pictures: design-shots/iphone-390/, iphone-430/, landscape-844/
node scripts/design/contact-sheet.mjs /tmp/sheet.png 280 design-shots/iphone-390/drive*.png
```

`e2e/screens.shots.ts` drives the real production build through the e2e harness (made-up
roads, stubbed GPS, voice and clock, a blank map style; no token, no network). To photograph
a new state, add a step there with `app.snap('<what it shows>')`. Look at the pictures
yourself (Read the PNG); a screenshot nobody looked at is not evidence.

The map in these pictures is the harness's blank style. For legibility over a real map,
see issue #47: never commit Mapbox/OSM stills or other products' screenshots (public repo).

## 2. The checklist (in order of what hurts a driver most)

1. **Glance**: what is the one thing this screen says? Is it the largest thing on it? At
   most two figures read at a glance while driving (design/README.md: 0.8 mi, 35 min).
2. **One primary action**: exactly one filled (white) button per screen. Secondary actions
   are raised or outlined. Nothing destructive next to the primary without space.
3. **Touch targets**: everything tapped while driving is at least 60 px high; everything
   else at least 44 px (Apple HIG 44 pt). Measure with `boundingBox()`, not by eye.
4. **Type**: while driving, no text under 14 px, sentences 16 px+, figures in Barlow
   Condensed. On the plan screen nothing under 13 px. Inputs 16 px (iOS zooms below).
5. **Contrast**: WCAG AA at least: 4.5:1 text, 3:1 large text and UI parts. Check pairs
   with `node scripts/design/contrast.mjs <fg> <bg>`. Think sunlight (light map, glare)
   and night (a white sheet is a torch in the driver's eyes).
6. **Colour means one thing**: amber is news (a pending or confirmed switch) and nothing
   else; white is the primary button. Colour is never the only signal: words or shape too.
7. **Safe areas and orientation**: notch, Dynamic Island, home indicator
   (`env(safe-area-inset-*)`); portrait 390x844 and 430x932, landscape 844x390. In
   landscape the car and the route ahead must still be visible.
8. **Reach**: actions in the bottom half; nothing the driver needs mid-drive at the top.
9. **Motion**: only transforms and opacity, under 300 ms, nothing that loops while driving,
   `prefers-reduced-motion` respected. Nothing moves when a number ticks (tabular digits,
   fixed boxes).
10. **Copy**: plain, short, the same words the voice says. No jargon (requests, probes,
    polls) on driving screens; that belongs in diagnostics. "Unknown is never zero".
11. **States**: loading, empty, error, partial data, offline, simulated GPS. Each has words
    that say what is happening and what to do; none is a blank or a spinner alone.
12. **Consistency**: tokens only (see the `design-tokens` skill); no new one-off colours,
    sizes or radii.

## 3. Write it up

Rank findings by **impact on a driver** (P1: could cause a wrong turn, a missed switch, a
look away for more than two seconds, or a failed tap; P2: slows the glance or erodes trust;
P3: polish). Each finding: the screenshot, what the driver experiences, the concrete fix
(CSS/copy/component), and the check that would catch it coming back. The audit lives in
`docs/design/ux-audit.md`; bigger fixes become issues labelled `area:design` + `p1`-`p3`.

## 4. Guard it

A fix is done when an e2e guard fails without it (CLAUDE.md, "Tests must prove behaviour"):
`e2e/design.spec.ts` (the design guards PR) checks axe accessibility, touch targets, text sizes and horizontal
overflow at phone sizes. Plant the regression, watch it go red, put that in the PR.
