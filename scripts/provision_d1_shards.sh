#!/usr/bin/env bash
# Provision one D1 database per state. Idempotent: skips existing.
# Emits a wrangler.toml fragment to data/v2/d1_bindings.toml that can be
# concat'd into wrangler.toml.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
: "${CLOUDFLARE_API_TOKEN:?}"
: "${CLOUDFLARE_ACCOUNT_ID:?}"

STATES=$(./refresh.sh states)
OUT="$ROOT/data/v2/d1_bindings.toml"
> "$OUT"

# Get current D1 list once.
EXISTING_JSON=$(wrangler d1 list --json 2>/dev/null || echo "[]")

resolve_id() {
  local name="$1"
  python3 -c "import sys,json; arr=json.loads(sys.argv[1]); [print(d.get('uuid') or d.get('id')) for d in arr if d.get('name')==sys.argv[2]]" "$EXISTING_JSON" "$name" | head -1
}

for ST in $STATES; do
  LC=$(echo "$ST" | tr '[:upper:]' '[:lower:]')
  NAME="hhapi-geo-$LC"
  ID=$(resolve_id "$NAME")
  if [[ -z "$ID" ]]; then
    echo "[d1-shards] creating $NAME"
    OUT_CREATE=$(wrangler d1 create "$NAME" 2>&1)
    ID=$(echo "$OUT_CREATE" | grep -oE 'database_id = "[a-f0-9-]+"' | grep -oE '[a-f0-9-]{36}')
    if [[ -z "$ID" ]]; then
      echo "  FAILED to create $NAME"
      echo "$OUT_CREATE"
      exit 1
    fi
    # Refresh the list cache for subsequent iterations.
    EXISTING_JSON=$(wrangler d1 list --json 2>/dev/null || echo "[]")
  else
    echo "[d1-shards] $NAME exists ($ID)"
  fi
  cat >>"$OUT" <<TOML

[[d1_databases]]
binding = "GEOCODE_$ST"
database_name = "$NAME"
database_id = "$ID"
TOML
done

echo "[d1-shards] wrote $OUT ($(grep -c d1_databases "$OUT") bindings)"
