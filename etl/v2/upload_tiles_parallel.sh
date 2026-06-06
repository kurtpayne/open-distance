#!/usr/bin/env bash
# Upload built tiles to R2 in parallel via xargs -P.
#
# Usage: upload_tiles_parallel.sh <VERSION> [CONCURRENCY=16]
set -euo pipefail
VERSION="${1:?usage: $0 <VERSION> [CONCURRENCY]}"
CONCURRENCY="${2:-16}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/data/v2/out/$VERSION/tiles"
BUCKET="hhapi-graph"

cd "$ROOT"

if [[ ! -d "$SRC" ]]; then
  echo "ERROR: $SRC missing" >&2
  exit 1
fi

count=$(ls -1 "$SRC"/*.bin 2>/dev/null | wc -l | tr -d ' ')
echo "[upload-r2] $count tiles, concurrency=$CONCURRENCY"

# Inline subshell function for parallel; xargs runs each line as `bash -c "..."`.
export BUCKET VERSION
ls -1 "$SRC"/*.bin | xargs -P "$CONCURRENCY" -I{} bash -c '
  f="$1"
  base=$(basename "$f")
  key="tiles/$VERSION/$base"
  if wrangler r2 object put "$BUCKET/$key" --file "$f" --remote >/dev/null 2>&1; then
    echo "  ok $key"
  else
    echo "FAILED $key" >&2
    exit 1
  fi
' _ {}

echo "[upload-r2] done."
