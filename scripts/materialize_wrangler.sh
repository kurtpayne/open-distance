#!/usr/bin/env bash
# Materialize wrangler.toml from wrangler.toml.template by substituting:
#   __CF_ACCOUNT_ID__    = $CLOUDFLARE_ACCOUNT_ID
#   __KV_CACHE_ID__      = id of the OD_API_CACHE KV namespace
#   __CUSTOM_DOMAIN__    = $OD_API_HOSTNAME (e.g. distance.example.com)
#   __D1_GEOCODE_<ST>__  = database_id of the od-geo-<st> D1 shard
#
# Idempotent: re-running re-derives every placeholder from the live CF state.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
: "${CLOUDFLARE_API_TOKEN:?Need CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?Need CLOUDFLARE_ACCOUNT_ID}"
: "${OD_API_HOSTNAME:=${HHAPI_HOSTNAME:-}}"
[[ -n "$OD_API_HOSTNAME" ]] || { echo "ERROR: OD_API_HOSTNAME not set (e.g. distance.example.com)" >&2; exit 1; }

TEMPLATE="$ROOT/wrangler.toml.template"
OUT="$ROOT/wrangler.toml"
[[ -f "$TEMPLATE" ]] || { echo "ERROR: $TEMPLATE missing" >&2; exit 1; }

# 1) Look up the KV namespace id by title.
KV_ID=$(wrangler kv namespace list 2>/dev/null \
  | python3 -c "import sys, json; arr=json.load(sys.stdin); print(next((k['id'] for k in arr if k.get('title') == 'OD_API_CACHE'), ''))")
[[ -n "$KV_ID" ]] || { echo "ERROR: OD_API_CACHE KV namespace not found. Run scripts/provision.sh first." >&2; exit 1; }

# 2) Look up each per-state D1 shard id.
declare -a STATES=( AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA \
                    MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD \
                    TN TX UT VT VA WA WV WI WY )

D1_LIST=$(wrangler d1 list --json 2>/dev/null || echo '[]')
declare -a SUBS=()
for ST in "${STATES[@]}"; do
  LC=$(echo "$ST" | tr '[:upper:]' '[:lower:]')
  NAME="od-geo-$LC"
  ID=$(echo "$D1_LIST" | python3 -c "import sys, json; arr=json.load(sys.stdin); print(next((d.get('uuid') or d.get('id') for d in arr if d.get('name')=='$NAME'), ''))")
  [[ -n "$ID" ]] || { echo "ERROR: D1 db $NAME not found. Run scripts/provision_d1_shards.sh first." >&2; exit 1; }
  SUBS+=(-e "s|__D1_GEOCODE_${ST}__|${ID}|g")
done

sed -e "s|__CF_ACCOUNT_ID__|${CLOUDFLARE_ACCOUNT_ID}|g" \
    -e "s|__KV_CACHE_ID__|${KV_ID}|g" \
    -e "s|__CUSTOM_DOMAIN__|${OD_API_HOSTNAME}|g" \
    "${SUBS[@]}" \
    "$TEMPLATE" > "$OUT"

# Sanity check: no placeholders left.
if grep -q "__.*__" "$OUT"; then
  echo "ERROR: unsubstituted placeholders remain in $OUT:" >&2
  grep "__.*__" "$OUT" | head -5 >&2
  exit 1
fi
echo "[materialize] wrote $OUT"
