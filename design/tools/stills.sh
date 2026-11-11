#!/usr/bin/env bash
# Film every still with the rehearsal gate and build one review sheet per direction.
#   bash tools/stills.sh <round-label>     (dev server must be running on 5273)
R=${1:-r}; U=http://127.0.0.1:5273
for d in clearway noodle vector; do
  for n in pick drive switch; do
    echo "== $d-$n"
    node scripts/film.mjs "$U/?capture=$d-$n" --still --gate --out shots/$R-$d-$n.png 2>&1 | grep -v "^still\|^coverage\|necessary, not\|no-issues"
  done
  python tools/montage.py shots/$R-$d.png 0.62 shots/$R-$d-pick.png shots/$R-$d-drive.png shots/$R-$d-switch.png
done
