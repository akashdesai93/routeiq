#!/usr/bin/env bash
# Film each direction's loop as a contact sheet with the rehearsal gate.
#   bash tools/loops.sh <round-label>     (dev server must be running on 5273)
R=${1:-m}; U=http://127.0.0.1:5273
for d in ${2:-clearway noodle vector}; do
  echo "== $d"
  node scripts/film.mjs "$U/?capture=$d-loop" --every 500 --count 20 --cols 10 --gate --out shots/$R-$d.png 2>&1 | grep -v "^20 frames" | cut -c1-330
  python -c "
from PIL import Image
im=Image.open('shots/$R-$d.png'); w=1950
im.convert('RGB').resize((w, round(im.height*w/im.width)), Image.LANCZOS).save('shots/$R-$d-s.png')"
done
