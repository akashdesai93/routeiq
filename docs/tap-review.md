# Tap review: every control, before and after a tap, judged by fresh eyes

Owner request on #203: a screenshot of every screen, state and control before and after
each tap, at phone size, as one browsable set, and a review of it by a reviewer who has not
seen the code. Run it on `main` or on any PR branch.

## 1. Make the set

```bash
npm run review:taps                   # Chromium, 390 x 844, touch: e2e-report/taps/index.html
npm run review:taps -- --webkit       # WebKit, iPhone 15 profile: e2e-report/webkit/taps/index.html
npm run e2e                           # (optional) the inventory: e2e-report/controls.md
```

`index.html` has one row per tap, click or typing in the `@tap` scenarios
(`e2e/controls.spec.ts`): the action, the element, the control the page saw activated, and
the screen before and 0.4 s after. `shots.json` has the same as data. The simulator flows of
#203 part 2 add their own screenshots and video as the `sim-drive` artifact.

## 2. Have it reviewed (a separate agent, fresh context)

Start a subagent that gets **only** these, not the code and not your conclusions:

- the contact sheet (`e2e-report/taps/index.html` and its pictures, or `shots.json`),
- the inventory (`e2e-report/controls.md`),
- the approved design: `design/exports/merged/*.png`, `design/README.md`,
  `docs/design/ux-audit.md`, and the design tokens skill (`.claude/skills/design-tokens`).

Brief it to judge, for each screen and each control:

1. **Function:** did the tap do what its label promises? Anything dead (the after shot is the
   same as the before shot when it should not be), mislabelled, unreachable, covered by
   another element, or so close to another control that a finger hits both?
2. **Looks:** spacing, how much of the screen the map gets, legibility at a glance in a car
   mount, consistency with the approved design. The owner finds the plan and drive screens
   congested (#197, PR #200).

It answers with one table: `screen | control | function ok? | looks ok? | what to fix`, with
the row's shot number for each finding.

## 3. Report

Post the table on the issue or PR it was run for. File each real finding as its own issue
(`triage`, a priority, `area:design`), with the shot and what the driver loses. A finding
already filed gets a link, not a second issue.
