#!/usr/bin/env bash
# Build displayxr-3d-photos.zip, the file a site owner uploads in
# WP Admin > Plugins > Add New Plugin > Upload Plugin.
#   ./integrations/wordpress/build.sh   ->   integrations/wordpress/dist/displayxr-3d-photos.zip
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
slug=displayxr-3d-photos
out="$here/dist"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$out" "$stage/$slug"
# The plugin folder minus the developer README, plus the SDK's license (Apache-2.0).
(cd "$here/$slug" && find . -type f ! -name README.md ! -name .DS_Store -print0 | \
  while IFS= read -r -d '' f; do mkdir -p "$stage/$slug/$(dirname "$f")"; cp "$f" "$stage/$slug/$f"; done)
cp "$repo/LICENSE" "$stage/$slug/LICENSE"

# The zip must hold the plugin FOLDER at its root, or WordPress installs it under the zip's name.
rm -f "$out/$slug.zip"
(cd "$stage" && zip -rq -X "$out/$slug.zip" "$slug")
unzip -l "$out/$slug.zip"
echo "built: $out/$slug.zip"
