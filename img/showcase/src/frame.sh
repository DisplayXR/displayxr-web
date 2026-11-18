#!/usr/bin/env bash
# Frame the "Made with the SDK" / featured-app showcase cards in one style.
#   img/showcase/src/<name>.webp  — the raw screenshot (16:10), kept unedited
#   img/showcase/src/backdrop.webp — shared backdrop (generated once with GPT-Image-2.5, no text)
#   badge — the DisplayXR inline3d plugin icon, bottom-right
# Output: img/showcase/<name>.webp at 640x400 (the size index.html declares).
# Usage (repo root, needs ImageMagick 7):  img/showcase/src/frame.sh [name ...]   (no args = all)
set -euo pipefail
cd "$(dirname "$0")"
OUT=..; ICON=../../../plugins/displayxr-inline3d/.claude-plugin/icon.png
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
magick backdrop.webp -resize 640x400^ -gravity center -extent 640x400 "$TMP/bd.png"
magick "$ICON" -resize 44x44 \( -size 44x44 xc:none -draw "roundrectangle 0,0,43,43,10,10" \) \
  -compose DstIn -composite "$TMP/badge.png"
names=("$@"); [ ${#names[@]} -gt 0 ] || names=($(ls *.webp | grep -v '^backdrop' | sed 's/\.webp$//'))
for f in "${names[@]}"; do
  magick "$TMP/bd.png" \
    \( "$f.webp" -resize 576x360^ -gravity center -extent 576x360 \
       \( -size 576x360 xc:none -draw "roundrectangle 0,0,575,359,14,14" \) -compose DstIn -composite \
       -compose Over -fill none -stroke '#ffffff38' -strokewidth 1.5 -draw "roundrectangle 0.75,0.75,574.25,358.25,14,14" \
       \( +clone -background black -shadow 70x12+0+8 \) +swap -background none -layers merge +repage \) \
    -gravity center -geometry +0-4 -compose Over -composite \
    \( "$TMP/badge.png" \( +clone -background black -shadow 60x4+0+2 \) +swap -background none -layers merge +repage \) \
    -gravity SouthEast -geometry +40+30 -compose Over -composite \
    -quality 88 "$OUT/$f.webp"
  echo "framed $f"
done
