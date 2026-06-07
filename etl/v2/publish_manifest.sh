#!/usr/bin/env bash
# Atomic version flip: writes a small JSON manifest to KV so Workers can
# resolve the active data version at runtime (future-facing). For now also
# verifies the env var DATA_VERSION matches what was just built and prints a
# reminder to redeploy if it doesn't.
set -euo pipefail
VERSION="${1:?usage: publish_manifest.sh <VERSION>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# KV namespace id for OD_API_CACHE (also used as manifest store).
KV_ID=$(grep -E 'id = "[0-9a-f]{32}"' "$ROOT/wrangler.toml" | head -1 | grep -oE '[0-9a-f]{32}')

# State coverage = whatever address shards we just built.
ADDR_DIR="$ROOT/data/v2/out/$VERSION/addresses"
STATES=$(cd "$ADDR_DIR" 2>/dev/null && ls *.csv 2>/dev/null | sed 's/.csv$//' | sort | tr '\n' ' ')

# Tile coverage = number of tiles built.
TILE_DIR="$ROOT/data/v2/out/$VERSION/tiles"
TILE_COUNT=$(ls "$TILE_DIR"/*.bin 2>/dev/null | wc -l | tr -d ' ')

MANIFEST=$(cat <<JSON
{
  "active_version": "$VERSION",
  "states": "$STATES",
  "tile_count": $TILE_COUNT,
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
)

echo "[publish] manifest:"
echo "$MANIFEST"

# Stash in KV under "manifest:active" key (future use; Worker not yet reading it).
echo "$MANIFEST" | wrangler kv key put --namespace-id "$KV_ID" --remote "manifest:active" --path /dev/stdin >/dev/null 2>&1 \
  && echo "[publish] wrote manifest:active to KV" \
  || echo "[publish] WARN: could not write to KV (continuing)"

# Confirm DATA_VERSION matches.
CURRENT=$(grep 'DATA_VERSION = ' "$ROOT/wrangler.toml" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
if [[ "$CURRENT" != "$VERSION" ]]; then
  echo "[publish] NOTE: wrangler.toml DATA_VERSION=$CURRENT but built $VERSION; redeploy to flip."
else
  echo "[publish] DATA_VERSION already at $VERSION"
fi
