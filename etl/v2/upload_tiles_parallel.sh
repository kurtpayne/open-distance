#!/usr/bin/env bash
# Upload built tiles to R2 in parallel via xargs -P. Logs every failure to a
# file so a partial upload can be retried cleanly.
#
# Usage: upload_tiles_parallel.sh <VERSION> [CONCURRENCY=16]
set -uo pipefail
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
FAILS="$ROOT/data/v2/upload_failures.txt"
: > "$FAILS"
echo "[upload-r2] $count tiles, concurrency=$CONCURRENCY"

export BUCKET VERSION FAILS
ls -1 "$SRC"/*.bin | xargs -P "$CONCURRENCY" -I{} bash -c '
  f="$1"
  base=$(basename "$f")
  key="tiles/$VERSION/$base"
  if wrangler r2 object put "$BUCKET/$key" --file "$f" --remote >/dev/null 2>&1; then
    : # ok, silent
  else
    echo "$f" >> "$FAILS"
  fi
' _ {}

ok=$((count - $(wc -l < "$FAILS" | tr -d " ")))
echo "[upload-r2] ok=$ok failed=$(wc -l < "$FAILS" | tr -d " ")"
if [[ -s "$FAILS" ]]; then
  echo "[upload-r2] re-trying failures from $FAILS"
  mv "$FAILS" "$FAILS.retry"
  : > "$FAILS"
  xargs -P "$CONCURRENCY" -I{} -a "$FAILS.retry" bash -c '
    f="$1"
    base=$(basename "$f")
    key="tiles/$VERSION/$base"
    if wrangler r2 object put "$BUCKET/$key" --file "$f" --remote >/dev/null 2>&1; then
      :
    else
      echo "$f" >> "$FAILS"
    fi
  ' _ {}
  if [[ -s "$FAILS" ]]; then
    echo "[upload-r2] still failed: $(wc -l < $FAILS | tr -d " ")"
    head -5 "$FAILS"
    exit 1
  fi
fi
echo "[upload-r2] done."
