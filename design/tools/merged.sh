#!/usr/bin/env bash
# Film every merged still with the rehearsal gate and build review sheets.
#   bash tools/merged.sh <round-label>     (dev server must be running on 5273)
R=${1:-g}; U=http://127.0.0.1:5273
for n in plan pick drive more switch-pending switch drive-day switch-day; do
  echo "== merged-$n"
  node scripts/film.mjs "$U/?capture=merged-$n" --still --gate --out shots/$R-$n.png 2>&1 | grep -v "^still\|^coverage\|necessary, not\|no-issues" | cut -c1-330
done
python tools/montage.py shots/$R-a.png 0.5 shots/$R-plan.png shots/$R-pick.png shots/$R-drive.png shots/$R-more.png
python tools/montage.py shots/$R-b.png 0.5 shots/$R-switch-pending.png shots/$R-switch.png shots/$R-drive-day.png shots/$R-switch-day.png
