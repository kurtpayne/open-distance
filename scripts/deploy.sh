#!/usr/bin/env bash
# Upload graph to R2, ensure API_KEY secret, deploy Worker.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?}"
: "${CLOUDFLARE_ACCOUNT_ID:?}"
: "${OD_API_KEY:?Need OD_API_KEY in env}"

DATA_VERSION=$(grep -E '^VERSION = ' etl/config.py | sed -E 's/.*"([^"]+)".*/\1/')
GRAPH_BIN="data/graph-${DATA_VERSION}.bin"
if [[ ! -f "$GRAPH_BIN" ]]; then
  echo "missing $GRAPH_BIN — run etl/build_graph.py first" >&2
  exit 1
fi

echo "[deploy] uploading $GRAPH_BIN to R2..."
wrangler r2 object put "od-graph/graph-${DATA_VERSION}.bin" --file "$GRAPH_BIN" --remote

echo "[deploy] setting API_KEY secret..."
echo -n "$OD_API_KEY" | wrangler secret put API_KEY

echo "[deploy] deploying worker..."
wrangler deploy

echo "[deploy] done."
