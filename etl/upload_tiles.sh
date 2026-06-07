#!/usr/bin/env bash
# Upload built tiles to R2: data/v2/out/<version>/tiles/<tx>_<ty>.bin -> od-graph/tiles/<version>/<tx>_<ty>.bin
set -euo pipefail
VERSION="${1:?usage: upload_tiles.sh <VERSION>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/data/v2/out/$VERSION/tiles"
BUCKET="od-graph"

if [[ ! -d "$SRC" ]]; then
  echo "ERROR: no tile output at $SRC" >&2
  exit 1
fi

count=$(ls -1 "$SRC"/*.bin 2>/dev/null | wc -l | tr -d ' ')
echo "[upload-r2] uploading $count tiles from $SRC -> r2://$BUCKET/tiles/$VERSION/"

i=0
for f in "$SRC"/*.bin; do
  i=$((i+1))
  base=$(basename "$f")
  key="tiles/$VERSION/$base"
  wrangler r2 object put "$BUCKET/$key" --file "$f" --remote >/dev/null 2>&1 \
    && echo "  [$i/$count] $key" \
    || { echo "FAILED uploading $key" >&2; exit 1; }
done
echo "[upload-r2] done."
