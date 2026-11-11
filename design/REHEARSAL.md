# Rehearsal: RouteIQ directions (Clearway, Noodle, Vector)

Gold: `examples/phone-touch` for the phone, its true-point screen and a loop
that is put back; `examples/phones` for the specimen sheet. Kept: the kit's
`Stage`, `Phone`, `Count`, `States`, the script API and marks. Changed: every
screen is whole in its frame (`unframed`, and `specimen` on the two comparison
sheets) because this is a design review the owner asked to see whole, not a
cropped marketing hero. That is a deliberate departure from the skill's
framing rules.

Beats (all three share `src/scene.ts`, 9.0 s): 1 driving on the 43 min route ·
2 faster route spotted, check 1 of 2 · 3 held up twice · 4 switch: the route
redraws, ETA rolls 43 to 35, lights 23 to 21, the voice line shows · 5 miles to
the turn count 0.8 to 0.5 · payoff: settled on the faster route, held 1.9 s ·
reset: the screen content dips to its own ground for about a quarter second
and the trip is put back unseen.

Captured: 428 px phone at 1:1 (stage 488 x 960), nine stills, three loops as
contact sheets every 500 ms, the comparison at 1300 wide, the gallery page
through `layout.mjs`. Light look only for Clearway and Noodle, dark only for
Vector.

Gate (last line of `film.mjs --gate`, every still, every loop, both comparison
sheets): `rehearsal passed`.

Film, by round:

- Stills round 1: `touching` on the mi/lights rows and legends → wrapped the
  words, fixed gaps. `uneven` on Clearway's status line → shortened the copy.
  Looked at the frames: Clearway's pick lines had rings colliding → hairline
  with solid beads; its slow stretch sat off screen → road geometry moved in.
  Noodle and Vector hero numerals were drawn tiny (a `span` rule was catching
  the kit's own spans) → unit class. Noodle ran under the status bar → paths
  end behind the turn card.
- Stills round 2: `tight inset` (Noodle card text), `uneven padding` (Noodle
  pop, the disc was two elements) → wrapper, one-element disc. Vector's
  "Straight" was cut by the screen edge → smaller. Vector's footer line was
  cut → shorter copy. Clearway's branch stopped mid-air → runs off the screen.
- Loops round 1: `jump` x10 and `vanishes with no exit` at the reset (state
  snapped under an opaque cover, which also dimmed the island) → the content
  itself now fades, status bar untouched. `lands on a transform` → lasting
  layers. The old distance digit ghosted over the arrow → `Count` instead of
  `Roll`.
- Loops round 2: looked at cropped frames and saw the road was not moving at
  all (the first-paint placing pass switched its transition off) → the road
  starts after it. A light passed under the driver without the count changing
  → lights kept ahead for the whole loop. Travel shortened so the turn stays
  ahead of the driver.
- Comparison: `framing` x3 (three whole phones) → `specimen`, even margins.
  Vector's road name sat on the rule under it after the `Count` change (no
  film line, seen in the frame) → figure refit.

Lines that stand:

- `near-empty frames` for about 250 ms at the reset. This is the loop cut. The
  alternative is rolling 35 min back to 43 in view, which would read as the
  trip getting slower.
- `jump: span "0".."9"` and `settle snap: span` at the switch: the kit's
  `Count` putting its digit strip back to the middle decade after a roll,
  inside its own clipped window. Not visible in any frame.
- `appears with no entrance: span.ss-count`: the same digit strip.
- Coverage is `inconclusive` on every loop: headless Chrome drops frames at 2x
  on this machine (gaps up to about 150 ms), so short motion between samples
  was not judged by the scan. The recorded GIFs were stepped at 80 ms with the
  clock slowed 5x and looked through.

Assumptions:

- The countdown in the switch is miles to the turn-off (0.8 to 0.5), not a
  timer the driver can cancel: the product is zero taps.
- Before the switch the next instruction is "Straight on" with no distance,
  because the brief gives only one turn (0.8 mi, Johnston Rd).
- Arrival times (10:16, 10:24) are the status bar's 9:41 plus the trip time.

Unresolved:

- The reset dip is the weakest quarter second of each loop.
- Clearway and Noodle have no night look; Vector has no day look.
- The home indicator stays black over Clearway's cobalt sheet (the kit draws
  it per phone, not per moment).

Not checked: a real phone in a car mount at arm's length, 390 px hosts,
reduced motion beyond the poster used for `comparison.png`, VoiceOver, any
screen other than the three asked for (no home, search, saved places or
recents yet).

---

# Rehearsal: the merged direction

Gold: `examples/phone-touch` again, plus the earlier Vector direction in this
project as the look. Whole phones (`unframed`, `specimen` on the sheets) for
the same reason as before.

Beats (`mergedScript` in `src/scene.ts`, 9.2 s): 1 driving, 43 min, straight
on · 2 pending: hollow amber marker and branch, "Faster route found", Keep my
route · 3 confirmed: marker fills, old route greys, the spoken sentence, 43 →
35 min, 10:24 → 10:16, turn card 0.8 mi Johnston Rd · 4 done: banner closes,
35 min, the distance counts 0.7, 0.6 · reset as before.

Captured: eight phone stills, the signal-state sheet, the comparison sheet at
1740 wide, the loop every 500 ms, a 12 s jump scan.

Gate: `rehearsal passed` on every still, the loop and both sheets.

Film, by round:

- Round 1: `uneven padding` on the sheet, the route card, the delta row and
  the ETA chip. Read the check: it measures leaf elements only, so bare digits
  inside a figure were not counted → digits wrapped, chip padded evenly, the
  grabber drawn as the sheet's own mark. Seen in the frames: the driver's
  arrow was white on white (an SVG colour rule) → fixed; three numbers at one
  weight on the driving sheet → arrival dimmed and reduced; the slow stretch
  was cut by the turn card → the street grid moved down; amber branch nearly
  invisible on the day map → black casing in daylight.
- Round 2: the More sheet covered the driver → tiles shortened, the repeated
  sentence dropped from it; the greyed route was hidden under its own hatch →
  shorter slow stretch; the Plan map showed a stray street name → removed.
- Round 3: on the comparison sheet the daylight hatch drew white (an SVG
  pattern takes its colour where it is defined, and ids are page-wide) → one
  pattern per theme. Signal tiles wrapped their hint → full width.

Lines that stand: the same four as above (reset dip of about 220 ms, the
kit's `Count` digit strip homing, `inconclusive` coverage from headless frame
drops).

Not checked: a real car mount in sunlight, VoiceOver, 390 px hosts, the
partial and unknown signal states inside the driving loop (they are shown on
the route card, delta row and More tile only), a declined switch ("Keep my
route" pressed) as its own state.

---

# Rehearsal: issues #43 to #46 (merged direction)

Gate: `rehearsal passed` on every new still, both merged loops, the three
exploration loops and all sheets, after the last change.

- #43: the declined banner first drew a notch where the trunk met the old
  route (casing drawn over the line) → casings drawn first; the branch now
  starts at the junction, so the pending marker has no tail.
- #44: partial and unknown tiles grew a line and pushed the sheet over the
  driver → the hint sits beside the value, one tile height in every state.
- #45: `uneven padding` on the turn card (bare digits are not measured) →
  digits wrapped; plain line set to fit the card.
- #46: reset is a cross-fade over a held opening frame. `near-empty frames`
  is gone. Remaining lines are the kit's `Count` digit strip homing and
  `appears with no entrance: div.rq-body` (the live screen returning over an
  identical frame). Film coverage stays `inconclusive`; with two screens per
  phone headless Chrome is slower still, so the seam was read from frames
  recorded at 80 ms with the clock slowed 5x.

Not checked: #47 (real map) has not been started in `src/`. The Noodle
exploration loop prints one `touching` line on its turn card (box overlap
only) since it moved to `Count`; left as it is.
